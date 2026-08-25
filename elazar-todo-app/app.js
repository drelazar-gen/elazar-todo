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

// Heartbeats are anchored to :25 and :55 UTC each hour (~every 30 min combined)
// — this cadence only matters now as the FALLBACK path, when the extension
// itself looks down and Heartbeat A steps in to do a manual scan.
const SYNC_CADENCE_MINUTES = 30;
const SYNC_GRACE_MINUTES = 5;
// The extension pings its own "I'm alive" timestamp every 5 minutes — this
// is the primary signal now. Allow for one missed cycle plus slack.
const EXTENSION_PING_STALE_MINUTES = 12;
const BACKGROUND_REFRESH_MS = 45000;

let state = {
  items: [],
  showCompleted: true,
  // 'all' | 'urgent' | 'delegated' | 'archived'
  view: 'all',
  status: {},
  // recordIds of cards whose inline note-entry box is currently open, and
  // whose note log is currently expanded past the default 3-entry preview —
  // kept outside `items` so a background refresh's full re-render doesn't
  // silently close/collapse something the person has open.
  openNoteEditors: new Set(),
  expandedNotes: new Set(),
};
let editingRecordId = null;
let lastSuccessfulSync = null;

const $ = (sel) => document.querySelector(sel);

// Keeps the calendar-icon button's face showing today's REAL live date
// (e.g. "AUG" / "24") instead of a static emoji — matches how a physical
// desk calendar or the iOS/Google Calendar app icon works. Uses Elazar's
// Florida time zone so it flips over at Eastern midnight, consistent with
// SNAPDATE elsewhere in this system, regardless of the viewer's own clock.
function updateCalendarButtonDate() {
  const monthEl = document.getElementById('calendar-btn-month');
  const dayEl = document.getElementById('calendar-btn-day');
  if (!monthEl || !dayEl) return;
  const now = new Date();
  const month = now.toLocaleDateString('en-US', { month: 'short', timeZone: 'America/New_York' });
  const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/New_York' });
  monthEl.textContent = month.toUpperCase();
  dayEl.textContent = day;
}
updateCalendarButtonDate();
// Cheap periodic check so the date rolls over automatically if the page
// is left open across midnight, without needing a full page refresh.
setInterval(updateCalendarButtonDate, 5 * 60000);

// Live-highlights a text field + its hint paragraph whenever the field's
// value starts with "EVENT:" (case-insensitive) — that prefix is what the
// automated check-in scans for to push an item onto the calendar (see the
// "EVENT:" markers step in the assistant's check-in). Returns the update
// function so callers can re-run it manually after programmatically
// changing the field's value (e.g. clearing it after submit, or loading a
// different item into the edit modal), since those don't fire 'input'.
function watchForEventPrefix(fieldEl, hintEl, defaultHTML, activeHTML) {
  // Defensive: if either element is missing (e.g. index.html and app.js
  // drifted out of sync — this happened for real on 2026-08-24, when a
  // missing #event-hint/#field-text-hint silently crashed this call and, by
  // extension, EVERY addEventListener wiring further down the file,
  // including the calendar button), degrade to a no-op instead of throwing.
  // One missing hint element should never be able to take down the rest of
  // the page's buttons.
  if (!fieldEl || !hintEl) {
    console.warn('[Elazar Todo] watchForEventPrefix: missing element(s) — skipping EVENT: highlighting for this field so the rest of the page still wires up.');
    return () => {};
  }
  const update = () => {
    const isEvent = /^event:/i.test(fieldEl.value.trim());
    fieldEl.classList.toggle('event-detected', isEvent);
    hintEl.classList.toggle('event-active', isEvent);
    hintEl.innerHTML = isEvent ? activeHTML : defaultHTML;
  };
  fieldEl.addEventListener('input', update);
  update();
  return update;
}

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

function minutesAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function formatRelative(iso) {
  const mins = minutesAgo(iso);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const now = new Date();
  const d = new Date(iso);
  const hrs = mins / 60;
  if (hrs < 24 && sameDay(d, now)) return `${Math.round(hrs)}h ago`;
  return formatPillTime(d, true);
}

// The capture "engine" is a single thing (one Chrome extension covers both
// WhatsApp and Google Messages), so both channel pills share this same
// health check — they only differ in their "last message" text below.
// Primary signal: the extension's own 5-minute heartbeat ping. If that's
// gone stale, fall back to checking whether Heartbeat A's manual-scan
// markers are fresh on their own 30-min cadence — which would mean Heartbeat
// A has correctly stepped in as the fallback, so things are still fine, just
// via the older path.
function captureEngineHealth() {
  const ext = state.status.extensionHeartbeat;
  if (ext && minutesAgo(ext) <= EXTENSION_PING_STALE_MINUTES) {
    return { healthy: true, via: 'extension', pingIso: ext };
  }

  const now = new Date();
  const scheduled = lastScheduledMark(now);
  const graceMs = SYNC_GRACE_MINUTES * 60 * 1000;
  const waFallback = state.status.whatsapp && new Date(state.status.whatsapp).getTime() >= scheduled.getTime() - graceMs;
  const gmFallback = state.status.messages && new Date(state.status.messages).getTime() >= scheduled.getTime() - graceMs;
  if (waFallback || gmFallback) {
    return { healthy: true, via: 'fallback', pingIso: state.status.whatsapp || state.status.messages };
  }

  return { healthy: false, via: null, pingIso: null };
}

function updateChannelPill(el, label, lastCaptureIso) {
  if (!el) return;
  const engine = captureEngineHealth();
  const lastMsgText = lastCaptureIso ? `last message ${formatRelative(lastCaptureIso)}` : 'no messages captured yet';

  if (engine.healthy) {
    el.className = 'pill pill-sm pill-green';
    const viaText = engine.via === 'extension' ? 'live via extension' : 'live via fallback scan';
    el.textContent = `${label} — ${viaText} · ${lastMsgText}`;
  } else {
    el.className = 'pill pill-sm pill-red';
    el.textContent = `${label} — capture offline · check the extension · ${lastMsgText}`;
  }
}

function refreshStatusPills() {
  updateChannelPill($('#whatsapp-pill'), 'WhatsApp', state.status.whatsappLastCapture);
  updateChannelPill($('#messages-pill'), 'Messages', state.status.messagesLastCapture);
}

/* ---------------- Rendering ---------------- */

// Items considered "urgent" for the Urgent tab/badge — matches the same
// condition that shows the red URGENT flag on a card (marked urgent and
// not yet checked off; once checked it drops off here too, same as the
// flag disappearing from the card).
function urgentItems() {
  return state.items.filter((it) => it.urgent && !it.checked && !it.archived);
}

function updateUrgentBadge() {
  const badge = $('#urgent-count-badge');
  if (!badge) return;
  const count = urgentItems().length;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

// Items with anyone in "Delegated To" — used by both the badge count and
// the Delegated tab itself.
function delegatedItems() {
  return state.items.filter((it) => it.delegatedToIds && it.delegatedToIds.length > 0);
}

function updateDelegatedBadge() {
  const badge = $('#delegated-count-badge');
  if (!badge) return;
  const count = delegatedItems().filter((it) => !it.checked).length;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

function populateSectionDatalist() {
  const datalist = $('#section-list');
  const allSections = Array.from(new Set([...PREFERRED_SECTION_ORDER, ...state.items.map((it) => it.section)]));
  datalist.innerHTML = allSections.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function render() {
  const container = $('#sections-container');
  container.innerHTML = '';

  updateUrgentBadge();
  updateDelegatedBadge();
  populateSectionDatalist();

  if (state.view === 'delegated') {
    renderDelegatedView(container);
    return;
  }

  // "All" and "Urgent" never show archived items (that's the whole point of
  // archiving something — it gets out of the way); the Archived tab shows
  // ONLY archived items, regardless of the "Show completed" toggle, since
  // an archived item is by definition something Elazar is done with.
  const baseItems = state.view === 'archived'
    ? state.items.filter((it) => it.archived)
    : state.items.filter((it) => !it.archived);

  const bySection = {};
  baseItems.forEach((item) => {
    if (!bySection[item.section]) bySection[item.section] = [];
    bySection[item.section].push(item);
  });

  const sectionNames = Object.keys(bySection).sort((a, b) => {
    const r = sectionRank(a) - sectionRank(b);
    if (r !== 0) return r;
    return a.localeCompare(b);
  });

  let renderedAny = false;

  sectionNames.forEach((section) => {
    let items = bySection[section].slice().sort((a, b) => a.order - b.order);
    if (state.view === 'urgent') {
      items = items.filter((it) => it.urgent);
    }
    if (state.view === 'archived') {
      items.sort((a, b) => a.order - b.order);
    } else if (!state.showCompleted) {
      items = items.filter((it) => !it.checked);
    } else {
      items.sort((a, b) => (a.checked === b.checked ? a.order - b.order : a.checked ? 1 : -1));
    }
    if (items.length === 0) return;
    renderedAny = true;

    const block = document.createElement('div');
    block.className = 'section-block';

    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = section;
    block.appendChild(title);

    items.forEach((item) => block.appendChild(renderItem(item, { archivedView: state.view === 'archived' })));
    container.appendChild(block);
  });

  if (!renderedAny) {
    const emptyMessages = {
      urgent: 'No urgent items right now. 🎉',
      archived: 'Nothing archived yet. Tag a note with <strong>@todo archive when done</strong> and it\'ll land here once you check it off.',
      all: 'Nothing on the list right now.',
    };
    container.innerHTML = `<div class="empty-state">${emptyMessages[state.view] || emptyMessages.all}</div>`;
  }
}

// Delegated tab — grouped by who it's delegated to (rather than by
// section), so Elazar can see at a glance who has what and whether they've
// checked it off, with a manual "Nudge" resend right there.
function renderDelegatedView(container) {
  const items = delegatedItems();
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">Nothing delegated yet. Tag a note with <strong>@todo delegate to [Name]</strong> to send someone their own checklist.</div>';
    return;
  }

  const byContact = {};
  items.forEach((item) => {
    const name = item.delegatedToName || 'Unknown contact';
    if (!byContact[name]) byContact[name] = [];
    byContact[name].push(item);
  });

  Object.keys(byContact).sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const group = byContact[name].slice().sort((a, b) => (a.checked === b.checked ? a.order - b.order : a.checked ? 1 : -1));
    const openCount = group.filter((it) => !it.checked).length;

    const block = document.createElement('div');
    block.className = 'contact-group';

    const title = document.createElement('div');
    title.className = 'contact-group-title';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    title.appendChild(nameSpan);
    const countSpan = document.createElement('span');
    countSpan.className = 'contact-group-count';
    countSpan.textContent = openCount > 0 ? `${openCount} still open` : 'all done ✓';
    title.appendChild(countSpan);
    block.appendChild(title);

    group.forEach((item) => block.appendChild(renderItem(item, { delegatedView: true })));
    container.appendChild(block);
  });
}

function renderArchiveStatusRow(item) {
  const wrap = document.createElement('div');
  wrap.className = 'archive-status-row';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'unarchive-btn';
  btn.textContent = '↩ Unarchive — move back to your list';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Unarchiving…';
    try {
      const result = await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', recordId: item.recordId, archived: false }),
      });
      const idx = state.items.findIndex((it) => it.recordId === item.recordId);
      if (idx !== -1) state.items[idx] = result.item;
      render();
    } catch (err) {
      alert('Could not unarchive: ' + err.message);
      btn.disabled = false;
      btn.textContent = '↩ Unarchive — move back to your list';
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderDelegateStatusRow(item) {
  const wrap = document.createElement('div');
  wrap.className = 'delegate-status-row';

  const status = document.createElement('span');
  if (item.checked) {
    status.className = 'delegate-status delegate-status-done';
    status.textContent = '✓ Done';
  } else if (item.delegateInviteSent) {
    status.className = 'delegate-status delegate-status-pending';
    status.textContent = 'Sent — awaiting them';
  } else {
    status.className = 'delegate-status delegate-status-unsent';
    status.textContent = 'Not sent yet';
  }
  wrap.appendChild(status);

  if (item.delegatedAt) {
    const at = document.createElement('span');
    at.className = 'note-entry-time';
    const d = new Date(item.delegatedAt + 'T00:00:00');
    at.textContent = 'Delegated ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    wrap.appendChild(at);
  }

  if (!item.checked) {
    const nudgeBtn = document.createElement('button');
    nudgeBtn.type = 'button';
    nudgeBtn.className = 'delegate-nudge-btn';
    nudgeBtn.textContent = 'Nudge';
    nudgeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      nudgeBtn.disabled = true;
      nudgeBtn.textContent = 'Sending…';
      try {
        await api('/api/items', {
          method: 'POST',
          body: JSON.stringify({ action: 'nudge', recordId: item.recordId }),
        });
        nudgeBtn.textContent = 'Sent ✓';
      } catch (err) {
        alert('Could not send nudge: ' + err.message);
        nudgeBtn.disabled = false;
        nudgeBtn.textContent = 'Nudge';
      }
    });
    wrap.appendChild(nudgeBtn);
  }

  return wrap;
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

/* ---------------- Multi-entry note log ---------------- */
// Each card's note/context field is a running, timestamped log rather than
// a single blob: every "Meta" value is either legacy freeform text (from
// before this feature existed) or a series of lines of the form
// "⁣NOTE⁣{"t":"<ISO timestamp>","x":"<entry text>"}" — one per
// entry, always appended at the end so entries read oldest-to-newest, new
// ones below the previous ones, exactly like a running log.
const NOTE_LINE_PREFIX = '⁣NOTE⁣';

function formatEntryTimestamp(date) {
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(date, now)) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

// Parses a Meta string into an ordered array of {time: Date|null, text}.
// Anything that isn't a recognized "⁣NOTE⁣{...}" line — including
// every pre-existing note ever saved before this feature shipped — is
// surfaced as a single untimestamped entry so nothing is ever lost or
// mangled, it just shows up without a timestamp.
function parseMetaEntries(meta) {
  if (!meta) return [];
  const lines = String(meta).split('\n');
  const entries = [];
  let legacyLines = [];
  const flushLegacy = () => {
    const text = legacyLines.join('\n').trim();
    if (text) entries.push({ time: null, text });
    legacyLines = [];
  };
  lines.forEach((line) => {
    if (line.startsWith(NOTE_LINE_PREFIX)) {
      flushLegacy();
      let parsed = null;
      try {
        const obj = JSON.parse(line.slice(NOTE_LINE_PREFIX.length));
        if (obj && typeof obj.x === 'string') parsed = obj;
      } catch (e) { /* malformed — fall through and keep the raw line visible below */ }
      if (parsed) {
        entries.push({ time: parsed.t ? new Date(parsed.t) : null, text: parsed.x });
      } else {
        entries.push({ time: null, text: line });
      }
    } else {
      legacyLines.push(line);
    }
  });
  flushLegacy();
  return entries;
}

// Appends one new timestamped entry to an existing Meta string.
function appendMetaEntry(existingMeta, text) {
  const line = NOTE_LINE_PREFIX + JSON.stringify({ t: new Date().toISOString(), x: text });
  return existingMeta ? `${existingMeta}\n${line}` : line;
}

// Plain-text reconstruction used only for the read-only preview in the
// full add/edit modal (see openModal) — never sent back to the server.
function formatMetaPreview(meta) {
  return parseMetaEntries(meta)
    .map((e) => (e.time ? `[${formatEntryTimestamp(e.time)}] ${e.text}` : e.text))
    .join('\n');
}

// Builds a "mention-aware textarea": a real (invisible-text) <textarea> for
// native typing/caret/undo behavior, stacked over a backdrop <div> that
// mirrors the same text with @tags highlighted. Returns a small controller
// object so callers don't need to know about the DOM internals.
// recurPicker: true wires up a live "how often?" picker that pops open the
// moment "@todo make recurring" is typed (before its closing parenthetical)
// — Daily / Weekly / Monthly / Custom — and appends the matching
// "(every day/week/month/N days)" suffix that the server's parseNoteTags()
// regex expects, so the whole thing round-trips without Elazar needing to
// know the exact syntax.
function createMentionField({ placeholder, rows, recurPicker } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'mention-field';

  const backdrop = document.createElement('div');
  backdrop.className = 'mention-backdrop';

  const textarea = document.createElement('textarea');
  textarea.className = 'mention-input';
  textarea.rows = rows || 2;
  if (placeholder) textarea.placeholder = placeholder;

  let picker = null;
  if (recurPicker) {
    picker = document.createElement('div');
    picker.className = 'recur-picker hidden';
    picker.innerHTML =
      '<span class="recur-picker-label">Repeat:</span>' +
      '<button type="button" data-interval="day">Daily</button>' +
      '<button type="button" data-interval="week">Weekly</button>' +
      '<button type="button" data-interval="month">Monthly</button>' +
      '<button type="button" data-interval="custom">Custom</button>' +
      '<span class="recur-custom-row hidden">' +
        '<input type="number" min="1" class="recur-custom-input" placeholder="days" />' +
        '<button type="button" class="recur-custom-confirm">Set</button>' +
      '</span>';
  }

  function applyRecurSuffix(suffix) {
    const val = textarea.value.replace(/\s+$/, '');
    textarea.value = `${val} (every ${suffix})`;
    sync();
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }

  function updateRecurPicker() {
    if (!picker) return;
    const val = textarea.value;
    const showPicker = /@todo\s+make\s*(?:this)?\s*recurring\b/i.test(val) && !/\(every\s+/i.test(val);
    picker.classList.toggle('hidden', !showPicker);
    if (!showPicker) picker.querySelector('.recur-custom-row').classList.add('hidden');
  }

  if (picker) {
    picker.querySelectorAll('button[data-interval]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const kind = btn.getAttribute('data-interval');
        if (kind === 'custom') {
          picker.querySelector('.recur-custom-row').classList.remove('hidden');
          picker.querySelector('.recur-custom-input').focus();
          return;
        }
        applyRecurSuffix(kind);
        picker.classList.add('hidden');
      });
    });
    const customInput = picker.querySelector('.recur-custom-input');
    const customConfirm = picker.querySelector('.recur-custom-confirm');
    const confirmCustom = () => {
      const n = parseInt(customInput.value, 10);
      if (!n || n < 1) { customInput.focus(); return; }
      applyRecurSuffix(`${n} day${n === 1 ? '' : 's'}`);
      picker.classList.add('hidden');
      customInput.value = '';
    };
    customConfirm.addEventListener('click', (e) => { e.preventDefault(); confirmCustom(); });
    customInput.addEventListener('click', (e) => e.stopPropagation());
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmCustom(); }
    });
  }

  function sync() {
    const val = textarea.value;
    // Trailing newline(s) collapse in a plain div — pad so the backdrop's
    // height/scroll stays matched to the textarea.
    backdrop.innerHTML = highlightMentionsHtml(val) + (/\n$/.test(val) ? '&nbsp;' : '');
    backdrop.scrollTop = textarea.scrollTop;
    updateRecurPicker();
  }

  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; });

  wrap.appendChild(backdrop);
  wrap.appendChild(textarea);
  if (picker) wrap.appendChild(picker);
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
  recurPicker: true,
});
$('#field-meta-mount').appendChild(metaField.el);

function renderItem(item, opts) {
  opts = opts || {};
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
  if (item.carriedOver && !item.checked) {
    const flag = document.createElement('span');
    flag.className = 'carried-over-flag';
    flag.textContent = 'CARRIED OVER';
    text.appendChild(flag);
  }
  if (item.reopened && !item.checked) {
    const flag = document.createElement('span');
    flag.className = 'reopened-flag';
    flag.textContent = 'PREVIOUSLY COMPLETED';
    text.appendChild(flag);
  }
  text.appendChild(document.createTextNode(item.text));
  body.appendChild(text);

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

  // Note/context always sits at the very bottom of the card, below the link,
  // so it's visible and editable right there without opening the item.
  const noteWrap = document.createElement('div');
  noteWrap.className = 'item-note-wrap';
  renderNoteWrap(item, noteWrap);
  body.appendChild(noteWrap);

  if (opts.archivedView) body.appendChild(renderArchiveStatusRow(item));
  if (opts.delegatedView) body.appendChild(renderDelegateStatusRow(item));

  row.appendChild(checkbox);
  row.appendChild(body);
  row.addEventListener('click', () => openModal(item));

  return row;
}

// Renders a card's note/context section: a running log of timestamped
// entries (oldest first, newest at the bottom) plus an "+ Add note"
// trigger — every card gets this, right there, no need to open the full
// editor first. More than 3 entries collapses to the latest 3 behind a
// "▼ See N earlier" toggle so a new entry is always visible immediately
// after being added, regardless of how long the log has gotten.
function renderNoteWrap(item, container) {
  container.innerHTML = '';

  const entries = parseMetaEntries(item.meta);
  const expanded = state.expandedNotes.has(item.recordId);

  if (entries.length) {
    const log = document.createElement('div');
    log.className = 'note-log';

    const hiddenCount = entries.length - 3;
    const showAll = expanded || hiddenCount <= 0;
    const visible = showAll ? entries : entries.slice(-3);

    if (hiddenCount > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'note-toggle';
      toggle.innerHTML = expanded
        ? '<span class="note-toggle-arrow note-toggle-arrow-up">▲</span> Hide'
        : `<span class="note-toggle-arrow">▼</span> See ${hiddenCount} earlier`;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expanded) state.expandedNotes.delete(item.recordId);
        else state.expandedNotes.add(item.recordId);
        renderNoteWrap(item, container);
      });
      log.appendChild(toggle);
    }

    visible.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'note-entry';
      if (entry.time) {
        const ts = document.createElement('span');
        ts.className = 'note-entry-time';
        ts.textContent = formatEntryTimestamp(entry.time);
        row.appendChild(ts);
      }
      const txt = document.createElement('span');
      txt.className = 'note-entry-text';
      txt.innerHTML = highlightMentionsHtml(entry.text);
      row.appendChild(txt);
      log.appendChild(row);
    });

    container.appendChild(log);
  }

  if (state.openNoteEditors.has(item.recordId)) {
    renderNoteInput(item, container, entries.length > 0);
  } else {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = entries.length ? 'note-edit-btn' : 'add-note-btn';
    addBtn.textContent = entries.length ? '+ Add note' : '+ Add note / context';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.openNoteEditors.add(item.recordId);
      renderNoteWrap(item, container);
    });
    container.appendChild(addBtn);
  }
}

// The single-line "add a note" box. Enter submits and appends a new
// timestamped entry (staying open so another can be typed right away —
// the entry that was just saved remains visible in the log above); Escape
// or the ✕ closes it without adding anything.
function renderNoteInput(item, container, hasEntries) {
  const wrap = document.createElement('div');
  wrap.className = 'note-input-row';
  wrap.addEventListener('click', (e) => e.stopPropagation());

  const field = createMentionField({
    placeholder: hasEntries ? 'Add another note…' : 'Add a note… tag @context for something you want handled.',
    rows: 1,
    recurPicker: true,
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'note-input-close';
  closeBtn.title = 'Close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.openNoteEditors.delete(item.recordId);
    renderNoteWrap(item, container);
  });

  wrap.appendChild(field.el);
  wrap.appendChild(closeBtn);
  container.appendChild(wrap);
  field.focus();

  const textareaEl = field.el.querySelector('.mention-input');
  textareaEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      state.openNoteEditors.delete(item.recordId);
      renderNoteWrap(item, container);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = field.getValue().trim();
      if (!val) return;
      textareaEl.disabled = true;
      try {
        const newMeta = appendMetaEntry(item.meta, val);
        const result = await api('/api/items', {
          method: 'POST',
          // newNoteText (the raw just-typed entry, separate from the full
          // meta log) lets the server detect @todo make-recurring/archive/
          // delegate tags instantly, without waiting for the hourly check-in.
          body: JSON.stringify({ action: 'update', recordId: item.recordId, meta: newMeta, newNoteText: val }),
        });
        const idx = state.items.findIndex((it) => it.recordId === item.recordId);
        if (idx !== -1) state.items[idx] = result.item;
        // Keep the editor open — a full re-render below rebuilds this same
        // card with the new entry now in its log and a fresh empty input
        // ready for the next one.
        state.openNoteEditors.add(item.recordId);
        render();
      } catch (err) {
        alert('Could not save note: ' + err.message);
        textareaEl.disabled = false;
      }
    }
  });
}

async function toggleItem(item, checked) {
  const prevChecked = item.checked;
  item.checked = checked; // optimistic
  render();
  try {
    // Capture the real returned record rather than just trusting `checked`
    // — e.g. an "@todo archive when done" item also gets Archived set
    // server-side the moment it's checked off, and this is what makes that
    // show up immediately instead of waiting for the next background poll.
    const result = await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle', recordId: item.recordId, checked }),
    });
    const idx = state.items.findIndex((it) => it.recordId === item.recordId);
    if (idx !== -1) state.items[idx] = result.item;
    render();
  } catch (e) {
    item.checked = prevChecked; // revert
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
  $('#field-link').value = item ? item.link : '';
  $('#field-urgent').checked = item ? item.urgent : false;
  updateFieldTextEventHint();

  const metaTextarea = metaField.el.querySelector('.mention-input');
  if (item) {
    // Notes now live as a timestamped log right on the card itself (see
    // renderNoteWrap/renderNoteInput) — showing the raw stored value here
    // and letting it be edited would risk silently clobbering that whole
    // history the next time this dialog is saved. Show a read-only plain-
    // text reconstruction for reference only; add/edit notes from the card.
    metaField.setValue(formatMetaPreview(item.meta));
    metaTextarea.disabled = true;
    $('#modal-meta-hint').textContent = 'Notes now live on the card itself — close this dialog and use "+ Add note" there.';
  } else {
    metaField.setValue('');
    metaTextarea.disabled = false;
    $('#modal-meta-hint').innerHTML = 'Tag <strong>@word</strong> (e.g. "@context") to flag a note as something for the assistant to act on, not just a note to yourself.';
  }

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
    link: $('#field-link').value.trim(),
    urgent: $('#field-urgent').checked,
  };
  // Meta is only ever set here for a brand-new item (the field is a
  // read-only preview when editing an existing one — see openModal) so an
  // edit-and-save never overwrites the card's real note log with this
  // dialog's plain-text reconstruction of it.
  if (!editingRecordId) {
    payload.meta = metaField.getValue().trim();
  }

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
    // it.meta is a snapshot of the card's raw Meta value at the time of the
    // 6am reset — parse it the same way the live card does so a multi-entry
    // note log renders as readable stacked lines here too, instead of raw
    // "⁣NOTE⁣{...}" blobs.
    const snapEntries = parseMetaEntries(it.meta);
    if (snapEntries.length) {
      const meta = document.createElement('div');
      meta.className = 'cal-item-meta';
      snapEntries.forEach((entry, i) => {
        if (i > 0) meta.appendChild(document.createElement('br'));
        if (entry.time) {
          const ts = document.createElement('span');
          ts.className = 'note-entry-time';
          ts.textContent = formatEntryTimestamp(entry.time);
          meta.appendChild(ts);
        }
        const txt = document.createElement('span');
        txt.innerHTML = highlightMentionsHtml(entry.text);
        meta.appendChild(txt);
      });
      body.appendChild(meta);
    }
    row.appendChild(body);

    // Uncheck / move back onto the current working list — for anything
    // that wasn't actually completed or needs another look. Requires a
    // short context note first (why it's being reopened) — that note gets
    // appended to the card's note log and a "PREVIOUSLY COMPLETED" badge
    // shows on the live card, so re-adding something isn't silent.
    const reopenWrap = document.createElement('div');
    reopenWrap.className = 'reopen-wrap';

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'ghost-btn small-btn';
    reopenBtn.textContent = 'Move to current list';

    const promptBox = document.createElement('div');
    promptBox.className = 'reopen-prompt hidden';

    const promptLabel = document.createElement('p');
    promptLabel.className = 'reopen-prompt-label';
    promptLabel.textContent = 'Why is this coming back? (required)';

    const promptInput = document.createElement('textarea');
    promptInput.className = 'reopen-prompt-input';
    promptInput.rows = 2;
    promptInput.placeholder = 'e.g. "Turned out the form was never actually submitted"';

    const promptActions = document.createElement('div');
    promptActions.className = 'reopen-prompt-actions';

    const promptCancel = document.createElement('button');
    promptCancel.type = 'button';
    promptCancel.className = 'ghost-btn small-btn';
    promptCancel.textContent = 'Cancel';

    const promptConfirm = document.createElement('button');
    promptConfirm.type = 'button';
    promptConfirm.className = 'primary-btn small-btn';
    promptConfirm.textContent = 'Move to current list';
    promptConfirm.disabled = true;

    promptInput.addEventListener('input', () => {
      promptConfirm.disabled = !promptInput.value.trim();
    });

    promptCancel.addEventListener('click', () => {
      promptBox.classList.add('hidden');
      reopenBtn.classList.remove('hidden');
      promptInput.value = '';
      promptConfirm.disabled = true;
    });

    reopenBtn.addEventListener('click', () => {
      reopenBtn.classList.add('hidden');
      promptBox.classList.remove('hidden');
      promptInput.focus();
    });

    promptConfirm.addEventListener('click', async () => {
      const note = promptInput.value.trim();
      if (!note) return;
      promptConfirm.disabled = true;
      promptCancel.disabled = true;
      promptInput.disabled = true;
      promptConfirm.textContent = 'Moving…';
      try {
        await api('/api/calendar', {
          method: 'POST',
          body: JSON.stringify({ action: 'reopen', date: dateStr, itemId: it.itemId, note }),
        });
        await loadItems();
        promptConfirm.textContent = 'Done ✓';
      } catch (err) {
        alert('Could not move item: ' + err.message);
        promptConfirm.disabled = false;
        promptCancel.disabled = false;
        promptInput.disabled = false;
        promptConfirm.textContent = 'Move to current list';
      }
    });

    promptActions.appendChild(promptCancel);
    promptActions.appendChild(promptConfirm);
    promptBox.appendChild(promptLabel);
    promptBox.appendChild(promptInput);
    promptBox.appendChild(promptActions);

    reopenWrap.appendChild(reopenBtn);
    reopenWrap.appendChild(promptBox);
    row.appendChild(reopenWrap);

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

$('#show-completed-toggle').textContent = state.showCompleted ? 'Hide completed' : 'Show completed';
$('#show-completed-toggle').addEventListener('click', () => {
  state.showCompleted = !state.showCompleted;
  $('#show-completed-toggle').textContent = state.showCompleted ? 'Hide completed' : 'Show completed';
  render();
});

function setActiveTab(view) {
  state.view = view;
  ['all', 'urgent', 'delegated', 'archived'].forEach((v) => {
    const tab = $(`#tab-${v}`);
    if (!tab) return;
    tab.classList.toggle('active', v === view);
    tab.setAttribute('aria-selected', String(v === view));
  });
  render();
}

$('#tab-all').addEventListener('click', () => setActiveTab('all'));
$('#tab-urgent').addEventListener('click', () => setActiveTab('urgent'));
$('#tab-delegated').addEventListener('click', () => setActiveTab('delegated'));
$('#tab-archived').addEventListener('click', () => setActiveTab('archived'));

$('#functions-btn').addEventListener('click', () => $('#functions-overlay').classList.remove('hidden'));
$('#functions-close').addEventListener('click', () => $('#functions-overlay').classList.add('hidden'));
$('#functions-overlay').addEventListener('click', (e) => {
  if (e.target === $('#functions-overlay')) $('#functions-overlay').classList.add('hidden');
});

const updateQuickAddEventHint = watchForEventPrefix(
  $('#quick-add-input'),
  $('#event-hint'),
  'Start an item with <strong>EVENT:</strong> (e.g. "EVENT: dinner with Sina Thursday 7pm") and the next automated check-in will add it to your calendar. Tap the <strong>+</strong> button below for a full editor with a link and urgent flag.',
  '📅 <strong>This will be added to your calendar</strong> — the next automated check-in picks up "EVENT:" items and creates them there.'
);

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
    updateQuickAddEventHint();
    await loadItems();
  } catch (err) {
    alert('Could not add: ' + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

const updateFieldTextEventHint = watchForEventPrefix(
  $('#field-text'),
  $('#field-text-hint'),
  'Start with <strong>EVENT:</strong> to have this pushed to your calendar too.',
  '📅 <strong>This will be added to your calendar</strong> when the next automated check-in runs.'
);

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
