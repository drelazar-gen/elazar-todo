const { sendEmail } = require('./email');

const BASE_ID = 'apptn2yEy7TRhdkNm';
const TABLE_ID = 'tbl5YWY1ZJkyQFqwA';
const SNAP_TABLE_ID = 'tblN363yqJug43X4L';
const HEARTBEAT_TABLE_ID = 'tblmmZ3d2aXGxz9Xw'; // "Heartbeat Findings" — written by the Chrome extension
const CONTACTS_TABLE_ID = 'tblL5jNEElKF3jJ1V'; // people items can be delegated to

const FIELDS = {
  id: 'fldrkj40W6BEqo7t7',
  section: 'fldSrDyNtDKCl7rQ6',
  order: 'fldu3EHzANg7Z3IXp',
  type: 'fldALdjmUxHFSSzFG',
  text: 'fld25jJR1AMopuNxi',
  meta: 'fldrN4aVSspePy7vr',
  link: 'fldKTM8Fk3wTp9MzM',
  checked: 'fld9pB5zVo9CKRu2U',
  urgent: 'fldEN9LbQAqLlvefi',
  updatedAt: 'fldKgBZtCvn17zSTz',
  aiReviewed: 'fldHGGCCQXAh26RIi',
  carriedOver: 'fld4eBYLc1sDmKSle',
  reopened: 'fldgxEjh2wJv3rHl8',
  archived: 'fldGaoxSvdPZ24Qz7',
  delegatedTo: 'fldWjl489txo5Veil', // multipleRecordLinks -> Contacts
  delegatedToName: 'fldd2qTkHZSrTGK3H', // lookup of Contacts.Name
  delegatedAt: 'fldS9GAjRcn2XTX7N',
  delegateInviteSent: 'fldcXTKTo9u0j1Itj',
  delegateLastNudge: 'fldAF0H87YnQb1HWw',
  recurring: 'fldqd9cvJprGG0KcJ',
  recurringInterval: 'fld1s3r607w9e5uPQ',
  recurringCustomDays: 'fldRHIJyQ838r4mQe',
  autoArchive: 'fldpkMsjUOgXwD9GN',
};

const APP_URL = 'https://elazar-todo.vercel.app';

const CONTACT_FIELDS = {
  name: 'fldcyNKQBb2dTxzBI',
  email: 'fldFGwezsssQW9cV2',
  phone: 'fldGHEqvk7cleuNU9',
  token: 'fldnPKzxpgBVJN1Gm',
};

// Mirrors the client-side NOTE_LINE_PREFIX format in app.js exactly — see
// the comment there for the full format description. Kept in sync manually
// since this runs server-side (the reopen flow appends a context note here,
// not in the browser).
const NOTE_LINE_PREFIX = '⁣NOTE⁣';

function appendMetaEntry(existingMeta, text) {
  const line = NOTE_LINE_PREFIX + JSON.stringify({ t: new Date().toISOString(), x: text });
  return existingMeta ? `${existingMeta}\n${line}` : line;
}

// Heartbeat Findings fields — used only to find the timestamp of the most
// recent message the extension actually captured per source, for the
// dashboard's "last message" text (informational, not a health check —
// silence here just means no new messages, not that anything is broken).
const HB_FIELDS = {
  source: 'fldvUGVp7u4pMrBCy',
  timestamp: 'fldtOHB8lPRkjDd63',
};

const SNAP_FIELDS = {
  key: 'fldi9CANHYbZ5ZEUl',
  date: 'fldhuwUMZjx9vWozu',
  itemId: 'fldRdHk7ssC8ROSFB',
  section: 'fld3yTsT2lBpvBGXc',
  text: 'fldbwotJbDS2TmxM7',
  meta: 'fldi6PxgJukcbdCcL',
  checked: 'fld92sGadqMxayOui',
  urgent: 'fldWcnLHUYsC51hdZ',
};

function getToken() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN env var is not set');
  return token;
}

async function airtableFetch(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.error ? JSON.stringify(body.error) : `Airtable request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function recordToItem(rec) {
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    id: f[FIELDS.id] || rec.id,
    section: f[FIELDS.section] || 'OTHER',
    order: typeof f[FIELDS.order] === 'number' ? f[FIELDS.order] : 9999,
    type: (f[FIELDS.type] && typeof f[FIELDS.type] === 'object' ? f[FIELDS.type].name : f[FIELDS.type]) || 'task',
    text: f[FIELDS.text] || '',
    meta: f[FIELDS.meta] || '',
    link: f[FIELDS.link] || '',
    checked: !!f[FIELDS.checked],
    urgent: !!f[FIELDS.urgent],
    updatedAt: f[FIELDS.updatedAt] || '',
    carriedOver: !!f[FIELDS.carriedOver],
    reopened: !!f[FIELDS.reopened],
    archived: !!f[FIELDS.archived],
    delegatedToIds: f[FIELDS.delegatedTo] || [],
    delegatedToName: (f[FIELDS.delegatedToName] && f[FIELDS.delegatedToName][0]) || '',
    delegatedAt: f[FIELDS.delegatedAt] || '',
    delegateInviteSent: !!f[FIELDS.delegateInviteSent],
    delegateLastNudge: f[FIELDS.delegateLastNudge] || '',
    recurring: !!f[FIELDS.recurring],
    recurringInterval: (f[FIELDS.recurringInterval] && typeof f[FIELDS.recurringInterval] === 'object' ? f[FIELDS.recurringInterval].name : f[FIELDS.recurringInterval]) || '',
    recurringCustomDays: typeof f[FIELDS.recurringCustomDays] === 'number' ? f[FIELDS.recurringCustomDays] : null,
    autoArchive: !!f[FIELDS.autoArchive],
  };
}

async function fetchAllRecords() {
  let records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    if (offset) qs.set('offset', offset);
    const page = await airtableFetch(`/${TABLE_ID}?${qs.toString()}`);
    records = records.concat(page.records || []);
    offset = page.offset;
  } while (offset);
  return records.map(recordToItem);
}

async function listItems() {
  const all = await fetchAllRecords();
  // Hide internal heartbeat/connectivity status rows — not real to-do items
  return all.filter((item) => !/^status_/.test(item.id));
}

// Most recent Heartbeat Findings record for one source ("WhatsApp" or
// "Google Messages"), i.e. the last time the extension actually captured a
// message from that source. Returns null if none exist yet.
async function getLastCaptureTimestamp(sourceName) {
  const qs = new URLSearchParams({
    pageSize: '1',
    returnFieldsByFieldId: 'true',
    filterByFormula: `{${HB_FIELDS.source}} = "${sourceName}"`,
  });
  qs.append('sort[0][field]', HB_FIELDS.timestamp);
  qs.append('sort[0][direction]', 'desc');
  const page = await airtableFetch(`/${HEARTBEAT_TABLE_ID}?${qs.toString()}`);
  const rec = (page.records || [])[0];
  return (rec && rec.fields && rec.fields[HB_FIELDS.timestamp]) || null;
}

// Two generations of "is this working" signal live side by side here:
//   - status_extension_heartbeat: the Chrome extension pings this every 5
//     minutes whenever it's installed and running — this is the primary
//     signal now.
//   - status_whatsapp_check / status_messages_check: the OLD Heartbeat A
//     full-browser-scan markers. Since Heartbeat A now only does a manual
//     scan as a fallback (when the extension looks down), these only get
//     touched during an actual fallback — a healthy extension means these
//     go stale on purpose, not because anything's broken.
// whatsappLastCapture / messagesLastCapture are the last time a real
// message was captured per source — informational, not a health check.
async function getStatus() {
  const [all, whatsappLastCapture, messagesLastCapture] = await Promise.all([
    fetchAllRecords(),
    getLastCaptureTimestamp('WhatsApp'),
    getLastCaptureTimestamp('Google Messages'),
  ]);
  const map = {};
  all.forEach((item) => {
    if (/^status_/.test(item.id)) map[item.id] = item.updatedAt || null;
  });
  return {
    whatsapp: map['status_whatsapp_check'] || null,
    messages: map['status_messages_check'] || null,
    extensionHeartbeat: map['status_extension_heartbeat'] || null,
    whatsappLastCapture,
    messagesLastCapture,
  };
}

/* ---------------- Instant @todo tag handling ---------------- */
// Three of the @todo sub-functions (make-recurring, archive-when-done,
// delegate) are fully deterministic — no natural-language date resolution
// needed — so they're detected and applied HERE, synchronously, the moment
// a note is saved. This is what makes them instant instead of waiting for
// the hourly automated check-in. (remind-me/escalate and put-on-calendar
// still need an LLM to resolve dates/times and stay on that check-in.)

function parseNoteTags(text) {
  if (!text) return null;
  const str = String(text);

  const recurMatch = str.match(/@todo\s+make\s*(?:this)?\s*recurring\s*\(every\s+(day|week|month|(\d+)\s*days?)\)/i);
  if (recurMatch) {
    const kind = recurMatch[1].toLowerCase();
    if (kind === 'day') return { type: 'recurring', interval: 'Daily' };
    if (kind === 'week') return { type: 'recurring', interval: 'Weekly' };
    if (kind === 'month') return { type: 'recurring', interval: 'Monthly' };
    return { type: 'recurring', interval: 'Custom', customDays: parseInt(recurMatch[2], 10) };
  }

  if (/@todo\s+(?:auto[\s-]?archive|archive\s+(?:this\s+)?when\s+done)\b/i.test(str)) {
    return { type: 'archive' };
  }

  const delegateMatch = str.match(/@todo\s+delegate\s+(?:this\s+)?to\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})/i);
  if (delegateMatch) {
    return { type: 'delegate', name: delegateMatch[1].trim() };
  }

  return null;
}

// Case-insensitive exact match on Contacts.Name. Returns the full contact
// (including email/token) since the caller needs those to send the invite.
async function findContactByName(name) {
  if (!name) return null;
  const safe = String(name).trim().replace(/"/g, '\\"');
  const qs = new URLSearchParams({
    pageSize: '1',
    returnFieldsByFieldId: 'true',
    filterByFormula: `LOWER({${CONTACT_FIELDS.name}}) = LOWER("${safe}")`,
  });
  const page = await airtableFetch(`/${CONTACTS_TABLE_ID}?${qs.toString()}`);
  const rec = (page.records || [])[0];
  if (!rec) return null;
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    name: f[CONTACT_FIELDS.name] || '',
    email: f[CONTACT_FIELDS.email] || '',
    phone: f[CONTACT_FIELDS.phone] || '',
    token: f[CONTACT_FIELDS.token] || '',
  };
}

function escapeHtmlBasic(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Fires the moment a delegation is set — this is plain deterministic code
// the app runs itself (not an AI agent choosing to send), so it's fine for
// it to send without a human clicking anything, same reasoning as the cron
// nudge sender. No-ops safely (returns {skipped:true}) until Elazar finishes
// the Resend setup.
async function sendDelegateInvite(item, contact) {
  if (!contact.email) return { skipped: true, reason: 'Contact has no email on file' };
  if (!contact.token) return { skipped: true, reason: 'Contact has no access token on file' };
  const link = `${APP_URL}/delegate.html?t=${encodeURIComponent(contact.token)}`;
  const subject = `A task from Elazar: ${item.text}`;
  const greetName = contact.name ? contact.name.split(' ')[0] : '';
  const text = `Hi ${greetName},\n\nElazar assigned you a to-do item:\n\n"${item.text}"\n\nView it and check it off here (no login needed):\n${link}\n`;
  const html = `<p>Hi ${escapeHtmlBasic(greetName)},</p><p>Elazar assigned you a to-do item:</p><p><strong>${escapeHtmlBasic(item.text)}</strong></p><p>View it and check it off here (no login needed):</p><p><a href="${link}">${link}</a></p>`;
  return sendEmail({ to: contact.email, subject, text, html });
}

// Applies a parsed tag's Airtable field writes onto `fields` in place, and
// returns the matched contact (if a delegate tag resolved to one) so the
// caller can send the invite AFTER the record is saved. Also appends an
// "Answered: ..." confirmation onto fields[meta] itself — this both gives
// Elazar visible confirmation right in the note thread AND, importantly,
// makes the hourly check-in's own @todo scanner skip this entry (it only
// acts on entries that don't already start with "Answered:"/"Needs your
// OK:"), so the same tag doesn't get redundantly reprocessed by the LLM an
// hour later.
async function applyNoteTag(newNoteText, fields) {
  const tag = parseNoteTags(newNoteText);
  if (!tag) return null;

  function confirm(text) {
    fields[FIELDS.meta] = appendMetaEntry(fields[FIELDS.meta] || '', text);
  }

  if (tag.type === 'recurring') {
    fields[FIELDS.recurring] = true;
    fields[FIELDS.recurringInterval] = tag.interval;
    if (tag.interval === 'Custom' && tag.customDays) fields[FIELDS.recurringCustomDays] = tag.customDays;
    const label = tag.interval === 'Custom'
      ? `every ${tag.customDays} day${tag.customDays === 1 ? '' : 's'}`
      : `every ${tag.interval.toLowerCase()}`;
    confirm(`Answered: Got it — this resets back to unchecked ${label} now.`);
    return null;
  }

  if (tag.type === 'archive') {
    fields[FIELDS.autoArchive] = true;
    confirm('Answered: Got it — this will move to your Archived tab automatically once you check it off.');
    return null;
  }

  if (tag.type === 'delegate') {
    const contact = await findContactByName(tag.name);
    if (!contact) return null; // unresolved — the hourly check-in's generic @todo handling will flag it
    fields[FIELDS.delegatedTo] = [contact.recordId];
    fields[FIELDS.delegatedAt] = new Date().toISOString().slice(0, 10);
    confirm(`Answered: Delegated to ${contact.name} — sending them a link now.`);
    return contact;
  }

  return null;
}

async function createItem(data) {
  const now = new Date().toISOString();
  const customId = `manual${Date.now()}`;
  const fields = {
    [FIELDS.id]: customId,
    [FIELDS.section]: data.section || 'ADDED BY YOU',
    [FIELDS.order]: Date.now() % 1000000,
    [FIELDS.type]: 'task',
    [FIELDS.text]: data.text || '',
    [FIELDS.meta]: data.meta || '',
    [FIELDS.link]: data.link || '',
    [FIELDS.checked]: false,
    [FIELDS.urgent]: !!data.urgent,
    [FIELDS.updatedAt]: now,
  };
  const delegateContact = await applyNoteTag(data.meta, fields);
  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true }),
  });
  const item = recordToItem(result.records[0]);
  if (delegateContact) {
    await sendDelegateInvite(item, delegateContact).then(async (r) => {
      if (r && r.sent) await updateItem(item.recordId, { delegateInviteSent: true });
    }).catch(() => {}); // never fail the save because the email attempt failed
  }
  return item;
}

// Single-record fetch — used sparingly (e.g. to check a flag not already
// known to the caller) rather than pulling the whole table.
async function getRecordFields(recordId) {
  const rec = await airtableFetch(`/${TABLE_ID}/${encodeURIComponent(recordId)}?returnFieldsByFieldId=true`);
  return (rec && rec.fields) || {};
}

async function updateItem(recordId, data) {
  const fields = {};
  if (data.text !== undefined) fields[FIELDS.text] = data.text;
  if (data.meta !== undefined) fields[FIELDS.meta] = data.meta;
  if (data.link !== undefined) fields[FIELDS.link] = data.link;
  if (data.section !== undefined) fields[FIELDS.section] = data.section;
  if (data.urgent !== undefined) fields[FIELDS.urgent] = !!data.urgent;
  if (data.checked !== undefined) {
    fields[FIELDS.checked] = !!data.checked;
    // A carried-over item that gets checked off is no longer "overdue" —
    // clear the badge so it doesn't keep showing on a completed item.
    if (data.checked) {
      fields[FIELDS.carriedOver] = false;
      fields[FIELDS.reopened] = false;
      // Auto-archive: an item tagged "@todo archive when done" (Auto Archive
      // checkbox) should move to Archived the moment it's checked off. Skip
      // this lookup if the caller already specified an explicit `archived`
      // value (e.g. the calendar's reopen flow never wants this).
      if (data.archived === undefined) {
        try {
          const existing = await getRecordFields(recordId);
          if (existing[FIELDS.autoArchive]) fields[FIELDS.archived] = true;
        } catch (e) { /* best-effort — never fail a checkbox toggle over this */ }
      }
    }
  }
  if (data.archived !== undefined) fields[FIELDS.archived] = !!data.archived;
  if (data.delegateInviteSent !== undefined) fields[FIELDS.delegateInviteSent] = !!data.delegateInviteSent;
  if (data.delegatedAt !== undefined) fields[FIELDS.delegatedAt] = data.delegatedAt;
  if (data.delegateLastNudge !== undefined) fields[FIELDS.delegateLastNudge] = data.delegateLastNudge;
  // newNoteText is the just-typed entry text (not the whole Meta log) —
  // passed separately by the client purely so tag-detection here only ever
  // looks at the fresh entry, never re-triggers on old history.
  const delegateContact = data.newNoteText !== undefined ? await applyNoteTag(data.newNoteText, fields) : null;
  fields[FIELDS.updatedAt] = new Date().toISOString();

  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: recordId, fields }], returnFieldsByFieldId: true }),
  });
  const item = recordToItem(result.records[0]);
  if (delegateContact) {
    // Awaited (not fire-and-forget) — a serverless function's background
    // work can get cut off once the response is sent, so this has to
    // finish before we return for the invite to reliably go out.
    await sendDelegateInvite(item, delegateContact).then(async (r) => {
      if (r && r.sent) await updateItem(item.recordId, { delegateInviteSent: true });
    }).catch(() => {}); // never fail the save because the email attempt failed
  }
  return item;
}

async function deleteItem(recordId) {
  await airtableFetch(`/${TABLE_ID}?records[]=${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
  });
  return { ok: true };
}

/* ---------------- Daily Snapshots (calendar view) ---------------- */
// One row per item per day, written once daily by the automated check-in
// at the 6am reset. Powers the calendar's colored-dot completion view.

async function fetchAllSnapshotRecords() {
  let records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    if (offset) qs.set('offset', offset);
    const page = await airtableFetch(`/${SNAP_TABLE_ID}?${qs.toString()}`);
    records = records.concat(page.records || []);
    offset = page.offset;
  } while (offset);
  return records;
}

function snapRecordToEntry(rec) {
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    key: f[SNAP_FIELDS.key] || '',
    date: f[SNAP_FIELDS.date] || '',
    itemId: f[SNAP_FIELDS.itemId] || '',
    section: f[SNAP_FIELDS.section] || '',
    text: f[SNAP_FIELDS.text] || '',
    meta: f[SNAP_FIELDS.meta] || '',
    checked: !!f[SNAP_FIELDS.checked],
    urgent: !!f[SNAP_FIELDS.urgent],
  };
}

// Returns [{date, total, checked, pct}] for every day in `yearMonth` (e.g. "2026-08")
// that has at least one snapshot row.
async function getMonthSummary(yearMonth) {
  const all = (await fetchAllSnapshotRecords()).map(snapRecordToEntry);
  const byDate = {};
  all.forEach((e) => {
    if (!e.date || !e.date.startsWith(yearMonth)) return;
    if (!byDate[e.date]) byDate[e.date] = { total: 0, checked: 0 };
    byDate[e.date].total += 1;
    if (e.checked) byDate[e.date].checked += 1;
  });
  return Object.keys(byDate)
    .map((date) => {
      const { total, checked } = byDate[date];
      return { date, total, checked, pct: total > 0 ? Math.round((checked / total) * 100) : 0 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getDayItems(date) {
  const all = (await fetchAllSnapshotRecords()).map(snapRecordToEntry);
  return all.filter((e) => e.date === date).sort((a, b) => a.section.localeCompare(b.section));
}

// "Uncheck / move to current working list" from the calendar: marks the
// snapshot row unchecked (so the dot color updates), and makes sure the
// item is present and unchecked in the live Items table — updating it if
// it still exists there, or recreating it from the snapshot if it was
// since deleted from the live list. Requires a context note explaining why
// it's being reopened (the UI enforces this before calling here); that note
// is appended to the item's Meta log exactly like any other note entry, and
// the Reopened flag is set so the card shows a "PREVIOUSLY COMPLETED" badge.
async function reopenSnapshotItem(date, itemId, note) {
  const trimmedNote = (note || '').trim();
  if (!trimmedNote) {
    throw new Error('A note explaining the reopen is required');
  }
  const entryText = `↩️ Reopened — ${trimmedNote}`;
  const key = `${date}_${itemId}`;

  await airtableFetch(`/${SNAP_TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({
      performUpsert: { fieldsToMergeOn: [SNAP_FIELDS.key] },
      records: [{ fields: { [SNAP_FIELDS.key]: key, [SNAP_FIELDS.checked]: false } }],
    }),
  });

  const liveAll = await fetchAllRecords();
  const live = liveAll.find((it) => it.id === itemId);
  if (live) {
    const newMeta = appendMetaEntry(live.meta, entryText);
    const result = await airtableFetch(`/${TABLE_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({
        records: [{
          id: live.recordId,
          fields: {
            [FIELDS.checked]: false,
            [FIELDS.reopened]: true,
            [FIELDS.meta]: newMeta,
            [FIELDS.updatedAt]: new Date().toISOString(),
          },
        }],
        returnFieldsByFieldId: true,
      }),
    });
    return recordToItem(result.records[0]);
  }

  const snapAll = (await fetchAllSnapshotRecords()).map(snapRecordToEntry);
  const snap = snapAll.find((e) => e.key === key) || snapAll.find((e) => e.date === date && e.itemId === itemId);
  const now = new Date().toISOString();
  const fields = {
    [FIELDS.id]: itemId,
    [FIELDS.section]: (snap && snap.section) || 'ADDED BY YOU',
    [FIELDS.order]: Date.now() % 1000000,
    [FIELDS.type]: 'task',
    [FIELDS.text]: (snap && snap.text) || '',
    [FIELDS.meta]: appendMetaEntry((snap && snap.meta) || '', entryText),
    [FIELDS.link]: '',
    [FIELDS.checked]: false,
    [FIELDS.urgent]: (snap && snap.urgent) || false,
    [FIELDS.reopened]: true,
    [FIELDS.updatedAt]: now,
  };
  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true }),
  });
  return recordToItem(result.records[0]);
}

/* ---------------- Contacts / delegation ---------------- */
// Contacts get a private, token-based portal (no password) that shows only
// the items delegated to them — see api/delegate.js. Never expose a
// contact's full record (email/phone) to another contact's token.

async function getContactByToken(token) {
  if (!token) return null;
  const safe = String(token).replace(/"/g, '\\"');
  const qs = new URLSearchParams({
    pageSize: '1',
    returnFieldsByFieldId: 'true',
    filterByFormula: `{${CONTACT_FIELDS.token}} = "${safe}"`,
  });
  const page = await airtableFetch(`/${CONTACTS_TABLE_ID}?${qs.toString()}`);
  const rec = (page.records || [])[0];
  if (!rec) return null;
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    name: f[CONTACT_FIELDS.name] || '',
    email: f[CONTACT_FIELDS.email] || '',
    phone: f[CONTACT_FIELDS.phone] || '',
  };
}

// Resolves a set of Contacts record ids to {recordId, name, email, phone,
// token} — used server-side only (by the cron sender), never returned to a
// browser, since it includes the access token.
async function getContactsByIds(ids) {
  const unique = Array.from(new Set(ids || []));
  if (!unique.length) return {};
  const formula = 'OR(' + unique.map((id) => `RECORD_ID()='${id}'`).join(',') + ')';
  const qs = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true', filterByFormula: formula });
  const page = await airtableFetch(`/${CONTACTS_TABLE_ID}?${qs.toString()}`);
  const map = {};
  (page.records || []).forEach((rec) => {
    const f = rec.fields || {};
    map[rec.id] = {
      recordId: rec.id,
      name: f[CONTACT_FIELDS.name] || '',
      email: f[CONTACT_FIELDS.email] || '',
      phone: f[CONTACT_FIELDS.phone] || '',
      token: f[CONTACT_FIELDS.token] || '',
    };
  });
  return map;
}

// Every item currently delegated to anyone (any Delegated To set) —
// includes checked/archived ones, since Elazar's Delegated tab and the
// cron sender both need the full picture, not just what's still open.
async function listDelegatedItems() {
  const all = await fetchAllRecords();
  return all.filter((it) => (it.delegatedToIds || []).length > 0 && !/^status_/.test(it.id));
}

// Items delegated to one specific contact — powers their private portal.
async function listItemsForContact(contactRecordId) {
  const all = await listDelegatedItems();
  return all.filter((it) => it.delegatedToIds.includes(contactRecordId));
}

// Manually re-sends the delegate invite/reminder email for one item — used
// by the "Nudge" button on Elazar's Delegated tab (and reusable later by a
// scheduled cron sweep). No-ops safely via sendEmail() if Resend isn't
// configured yet or the contact has no email on file.
async function nudgeDelegatedItem(recordId) {
  const all = await fetchAllRecords();
  const item = all.find((it) => it.recordId === recordId);
  if (!item) throw new Error('Item not found');
  if (!item.delegatedToIds || !item.delegatedToIds.length) throw new Error('This item is not delegated to anyone');
  const contacts = await getContactsByIds(item.delegatedToIds);
  const contact = contacts[item.delegatedToIds[0]];
  if (!contact) throw new Error('Contact not found');
  const result = await sendDelegateInvite(item, contact);
  await updateItem(recordId, { delegateLastNudge: new Date().toISOString().slice(0, 10) });
  return result;
}

module.exports = {
  listItems,
  createItem,
  updateItem,
  deleteItem,
  getStatus,
  getLastCaptureTimestamp,
  getMonthSummary,
  getDayItems,
  reopenSnapshotItem,
  getContactByToken,
  getContactsByIds,
  listDelegatedItems,
  listItemsForContact,
  nudgeDelegatedItem,
};
