const crypto = require('crypto');
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
  nudgeMode: 'fldTaLzVRCtKCNPuR', // singleSelect: Manual/Auto
  nudgeInterval: 'fldcOLa3aiygxvhn2', // singleSelect: Daily/Weekly/Monthly/Custom
  nudgeCustomDays: 'fldZAViZgLRSaoF3Z',
  delegateMode: 'fld05IISJfNF0XGxI', // singleSelect: Any/All — added for multi-delegate (2026-08-25)
  delegateCompletedBy: 'fldJlfvCR8Fn1b8pG', // multipleRecordLinks -> Contacts — per-person completion in "All" mode
};

const APP_URL = 'https://elazar-todo.vercel.app';

// Who gets notified when a delegate sends a message back — defaults to
// Elazar's own address but stays env-overridable so the replication
// template can point each new deployment at its own owner.
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'drelazar@genesischiropracticrc.com';

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
    delegatedToNames: Array.isArray(f[FIELDS.delegatedToName]) ? f[FIELDS.delegatedToName] : (f[FIELDS.delegatedToName] ? [f[FIELDS.delegatedToName]] : []),
    delegatedAt: f[FIELDS.delegatedAt] || '',
    delegateInviteSent: !!f[FIELDS.delegateInviteSent],
    delegateLastNudge: f[FIELDS.delegateLastNudge] || '',
    delegateMode: (f[FIELDS.delegateMode] && typeof f[FIELDS.delegateMode] === 'object' ? f[FIELDS.delegateMode].name : f[FIELDS.delegateMode]) || 'Any',
    delegateCompletedByIds: f[FIELDS.delegateCompletedBy] || [],
    recurring: !!f[FIELDS.recurring],
    recurringInterval: (f[FIELDS.recurringInterval] && typeof f[FIELDS.recurringInterval] === 'object' ? f[FIELDS.recurringInterval].name : f[FIELDS.recurringInterval]) || '',
    recurringCustomDays: typeof f[FIELDS.recurringCustomDays] === 'number' ? f[FIELDS.recurringCustomDays] : null,
    autoArchive: !!f[FIELDS.autoArchive],
    nudgeMode: (f[FIELDS.nudgeMode] && typeof f[FIELDS.nudgeMode] === 'object' ? f[FIELDS.nudgeMode].name : f[FIELDS.nudgeMode]) || 'Manual',
    nudgeInterval: (f[FIELDS.nudgeInterval] && typeof f[FIELDS.nudgeInterval] === 'object' ? f[FIELDS.nudgeInterval].name : f[FIELDS.nudgeInterval]) || '',
    nudgeCustomDays: typeof f[FIELDS.nudgeCustomDays] === 'number' ? f[FIELDS.nudgeCustomDays] : null,
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
//
// MULTI-COMMAND SUPPORT (added 2026-08-25): a note can contain more than one
// @todo command (e.g. delegate AND make-recurring on the same entry). When
// more than one command is present they must be wrapped individually in
// curly braces — {@todo delegate to Jane} {@todo make recurring (every week)}
// — so each command's own text stays visually and structurally separate (this
// mirrors the highlighting app.js now applies to the same braces). A note
// with exactly ONE command never needs braces — the old unbracketed
// "@todo ..." form still works exactly as before for backward compatibility
// with anything already saved or hand-typed.

// Splits a note into one or more command segments to parse independently.
// If the note contains any {...} groups, ONLY those groups are treated as
// commands (text outside braces is plain commentary). If it contains none,
// the whole string is treated as a single legacy-style segment.
function extractTagSegments(str) {
  const segments = [];
  const bracketRe = /\{([^{}]*)\}/g;
  let m;
  while ((m = bracketRe.exec(str))) segments.push(m[1]);
  if (!segments.length) segments.push(str);
  return segments;
}

// Parses ONE command segment into a tag object, or null if it isn't a
// recognized @todo command.
function parseOneTag(segment) {
  const str = String(segment);

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

  // Delegate — now supports MULTIPLE people/teams/groups, comma- or
  // "and"-separated ("delegate to Jane, Mike and Sales Team"), plus two
  // optional parenthetical modifiers that can appear in either order:
  //   (mode: any)  — default. First person to complete it checks off the
  //                  whole item for everyone (same as the old single-delegate
  //                  behavior).
  //   (mode: all)  — each person completes their OWN copy independently;
  //                  the item only checks off once every one of them has.
  //   (nudge: manual) or (nudge: auto every day/week/month/N days)
  const delegateMatch = str.match(/@todo\s+delegate\s+(?:this\s+)?to\s+([^(){}]+?)\s*(?=\(|$)/i);
  if (delegateMatch) {
    const namesRaw = delegateMatch[1].trim();
    const names = namesRaw
      .split(/\s*,\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return null;

    const modeMatch = str.match(/\(mode:\s*(any|all)\)/i);
    const mode = modeMatch && modeMatch[1].toLowerCase() === 'all' ? 'All' : 'Any';

    const nudgeMatch = str.match(/\(nudge:\s*(manual|auto\s+every\s+(day|week|month|(\d+)\s*days?))\)/i);
    let nudge = { mode: 'manual' };
    if (nudgeMatch && /^auto/i.test(nudgeMatch[1])) {
      const kind = nudgeMatch[2].toLowerCase();
      if (kind === 'day') nudge = { mode: 'auto', interval: 'Daily' };
      else if (kind === 'week') nudge = { mode: 'auto', interval: 'Weekly' };
      else if (kind === 'month') nudge = { mode: 'auto', interval: 'Monthly' };
      else nudge = { mode: 'auto', interval: 'Custom', customDays: parseInt(nudgeMatch[3], 10) };
    }
    return { type: 'delegate', names, mode, nudge };
  }

  return null;
}

// Returns an ARRAY of parsed tags (possibly empty) — one per recognized
// command segment. See extractTagSegments/parseOneTag above.
function parseNoteTags(text) {
  if (!text) return [];
  const segments = extractTagSegments(String(text));
  return segments.map(parseOneTag).filter(Boolean);
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

// Applies ONE parsed tag's Airtable field writes onto `fields` in place.
// Returns an array of matched delegate contacts (empty for non-delegate
// tags, or when a delegate tag's name(s) didn't resolve to anyone).
async function applyOneTag(tag, fields) {
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
    return [];
  }

  if (tag.type === 'archive') {
    fields[FIELDS.autoArchive] = true;
    confirm('Answered: Got it — this will move to your Archived tab automatically once you check it off.');
    return [];
  }

  if (tag.type === 'delegate') {
    const resolutions = await Promise.all(tag.names.map(async (name) => ({ name, contact: await findContactByName(name) })));
    const resolved = resolutions.filter((r) => r.contact);
    const unresolved = resolutions.filter((r) => !r.contact).map((r) => r.name);
    if (!resolved.length) return []; // none resolved — the hourly check-in's generic @todo handling will flag it

    fields[FIELDS.delegatedTo] = resolved.map((r) => r.contact.recordId);
    fields[FIELDS.delegatedAt] = new Date().toISOString().slice(0, 10);
    fields[FIELDS.delegateMode] = tag.mode; // 'Any' or 'All'
    fields[FIELDS.delegateCompletedBy] = []; // reset per-person completion whenever delegation is (re)set

    let nudgeLabel = 'manual nudges only';
    if (tag.nudge && tag.nudge.mode === 'auto') {
      fields[FIELDS.nudgeMode] = 'Auto';
      fields[FIELDS.nudgeInterval] = tag.nudge.interval;
      if (tag.nudge.interval === 'Custom' && tag.nudge.customDays) fields[FIELDS.nudgeCustomDays] = tag.nudge.customDays;
      nudgeLabel = tag.nudge.interval === 'Custom'
        ? `auto-nudging every ${tag.nudge.customDays} day${tag.nudge.customDays === 1 ? '' : 's'}`
        : `auto-nudging every ${tag.nudge.interval.toLowerCase()}`;
    } else {
      fields[FIELDS.nudgeMode] = 'Manual';
    }

    const namesLabel = resolved.map((r) => r.contact.name).join(', ');
    const modeNote = resolved.length > 1
      ? (tag.mode === 'All' ? ' — everyone needs to check off their own copy' : ' — just ONE of them needs to check it off')
      : '';
    let msg = `Answered: Delegated to ${namesLabel}${modeNote} (${nudgeLabel}) — sending them links now.`;
    if (unresolved.length) msg += ` (Couldn't find a saved contact for: ${unresolved.join(', ')} — add them via the delegate picker and re-delegate.)`;
    confirm(msg);
    return resolved.map((r) => r.contact);
  }

  return [];
}

// Parses ALL command segments in the just-typed note text and applies each
// one's Airtable field writes onto `fields` in place. Returns the combined
// array of matched delegate contacts across every delegate command found
// (usually 0 or 1 commands, but multi-command notes can contain more) so the
// caller can send invite emails AFTER the record is saved.
async function applyNoteTags(newNoteText, fields) {
  const tags = parseNoteTags(newNoteText);
  if (!tags.length) return [];
  const allContacts = [];
  for (const tag of tags) {
    const contacts = await applyOneTag(tag, fields);
    if (contacts && contacts.length) allContacts.push(...contacts);
  }
  return allContacts;
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
  const delegateContacts = await applyNoteTags(data.meta, fields);
  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true }),
  });
  const item = recordToItem(result.records[0]);
  if (delegateContacts && delegateContacts.length) {
    let anySent = false;
    for (const contact of delegateContacts) {
      await sendDelegateInvite(item, contact).then((r) => { if (r && r.sent) anySent = true; }).catch(() => {}); // never fail the save because an email attempt failed
    }
    if (anySent) await updateItem(item.recordId, { delegateInviteSent: true });
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
  const delegateContacts = data.newNoteText !== undefined ? await applyNoteTags(data.newNoteText, fields) : [];
  fields[FIELDS.updatedAt] = new Date().toISOString();

  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: recordId, fields }], returnFieldsByFieldId: true }),
  });
  const item = recordToItem(result.records[0]);
  if (delegateContacts && delegateContacts.length) {
    // Awaited (not fire-and-forget) — a serverless function's background
    // work can get cut off once the response is sent, so this has to
    // finish before we return for the invites to reliably go out.
    let anySent = false;
    for (const contact of delegateContacts) {
      await sendDelegateInvite(item, contact).then((r) => { if (r && r.sent) anySent = true; }).catch(() => {}); // never fail the save because an email attempt failed
    }
    if (anySent) await updateItem(item.recordId, { delegateInviteSent: true });
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

function randomToken() {
  return crypto.randomBytes(20).toString('hex'); // unguessable — this alone gates the delegate portal, see delegate.html/api/delegate.js
}

// {recordId, name, email, phone} — deliberately omits the access token; this
// is the shape returned to Elazar's own browser (api/contacts.js), for the
// @todo delegate-to search/add-new picker. The token stays server-side only.
function contactRecordToPublic(rec) {
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    name: f[CONTACT_FIELDS.name] || '',
    email: f[CONTACT_FIELDS.email] || '',
    phone: f[CONTACT_FIELDS.phone] || '',
  };
}

async function listContacts() {
  const qs = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
  const page = await airtableFetch(`/${CONTACTS_TABLE_ID}?${qs.toString()}`);
  return (page.records || []).map(contactRecordToPublic);
}

// Simple client-side-style substring filter on name — the Contacts table is
// small (Elazar's own contact list), so pulling all and filtering in memory
// is simpler and plenty fast rather than building an Airtable formula.
async function searchContacts(query) {
  const all = await listContacts();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all.slice(0, 25);
  return all.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 25);
}

async function createContact(data) {
  const name = String((data && data.name) || '').trim();
  if (!name) throw new Error('Name is required');
  const fields = {
    [CONTACT_FIELDS.name]: name,
    [CONTACT_FIELDS.email]: String((data && data.email) || '').trim(),
    [CONTACT_FIELDS.phone]: String((data && data.phone) || '').trim(),
    [CONTACT_FIELDS.token]: randomToken(),
  };
  const result = await airtableFetch(`/${CONTACTS_TABLE_ID}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true }),
  });
  return contactRecordToPublic(result.records[0]);
}

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

// Manually re-sends the delegate invite/reminder email for EVERY person an
// item is delegated to — used by the "Nudge" button on Elazar's Delegated
// tab (and reusable later by a scheduled cron sweep). In "All" mode, skips
// anyone who has already completed their own copy (no point nudging them).
// No-ops safely via sendEmail() if Resend isn't configured yet or a contact
// has no email on file.
async function nudgeDelegatedItem(recordId) {
  const all = await fetchAllRecords();
  const item = all.find((it) => it.recordId === recordId);
  if (!item) throw new Error('Item not found');
  if (!item.delegatedToIds || !item.delegatedToIds.length) throw new Error('This item is not delegated to anyone');
  const contactsMap = await getContactsByIds(item.delegatedToIds);
  const completedIds = item.delegateMode === 'All' ? (item.delegateCompletedByIds || []) : [];
  const results = [];
  for (const id of item.delegatedToIds) {
    if (completedIds.includes(id)) continue; // already done their part in All mode
    const contact = contactsMap[id];
    if (!contact) { results.push({ skipped: true, reason: 'contact not found' }); continue; }
    results.push(await sendDelegateInvite(item, contact));
  }
  await updateItem(recordId, { delegateLastNudge: new Date().toISOString().slice(0, 10) });
  return { results };
}

// Toggles ONE contact's completion on a delegated item. In "Any" mode (the
// default, and always for single-delegate items) this behaves exactly like
// before — it just flips the shared Checked field directly. In "All" mode,
// each contact's completion is tracked separately in Delegate Completed By,
// and the shared Checked field only flips true once every delegated contact
// has completed their own copy (and flips back false if anyone un-completes
// after that). Used by the delegate portal (api/delegate.js) instead of a
// raw updateItem({checked}) call so multi-delegate "All" items track
// per-person progress correctly.
async function markDelegateComplete(recordId, contactRecordId, completed) {
  const existing = await getRecordFields(recordId);
  const mode = (existing[FIELDS.delegateMode] && typeof existing[FIELDS.delegateMode] === 'object' ? existing[FIELDS.delegateMode].name : existing[FIELDS.delegateMode]) || 'Any';
  const delegatedToIds = existing[FIELDS.delegatedTo] || [];

  if (mode !== 'All' || delegatedToIds.length <= 1) {
    return updateItem(recordId, { checked: completed });
  }

  let completedBy = existing[FIELDS.delegateCompletedBy] || [];
  if (completed) {
    if (!completedBy.includes(contactRecordId)) completedBy = completedBy.concat([contactRecordId]);
  } else {
    completedBy = completedBy.filter((id) => id !== contactRecordId);
  }
  const allDone = delegatedToIds.every((id) => completedBy.includes(id));
  const fields = {
    [FIELDS.delegateCompletedBy]: completedBy,
    [FIELDS.checked]: allDone,
    [FIELDS.updatedAt]: new Date().toISOString(),
  };
  if (allDone) { fields[FIELDS.carriedOver] = false; fields[FIELDS.reopened] = false; }
  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: recordId, fields }], returnFieldsByFieldId: true }),
  });
  return recordToItem(result.records[0]);
}

// Lets a delegate send a free-text message back on an item from their
// portal (delegate.html) — e.g. a question, a status update, or "can't do
// this one, can someone else?". Appended to the item's Meta log exactly
// like any other note entry (so it shows up in the normal history — no new
// UI concept needed on Elazar's side), attributed with the sender's name so
// it reads clearly among his own notes. Also emails Elazar so a message
// doesn't just sit silently until he happens to reopen that item — this is
// deterministic notification code, not an AI agent choosing to send.
async function addDelegateMessage(recordId, contactRecordId, contactName, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw new Error('Message is empty');
  if (trimmed.length > 2000) throw new Error('Message is too long');

  const existing = await getRecordFields(recordId);
  const senderLabel = contactName || 'Delegate';
  const entryText = `💬 ${senderLabel} says: ${trimmed}`;
  const newMeta = appendMetaEntry(existing[FIELDS.meta] || '', entryText);

  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({
      records: [{ id: recordId, fields: { [FIELDS.meta]: newMeta, [FIELDS.updatedAt]: new Date().toISOString() } }],
      returnFieldsByFieldId: true,
    }),
  });
  const item = recordToItem(result.records[0]);

  // Awaited (not fire-and-forget) — a serverless function's background work
  // can get cut off once the response is sent, same reasoning as the
  // delegate-invite sends above, so this has to finish before we return.
  await sendEmail({
    to: OWNER_EMAIL,
    subject: `${senderLabel} replied: ${item.text}`,
    text: `${senderLabel} sent a message on "${item.text}":\n\n"${trimmed}"\n\nOpen your to-do list to see it in context:\n${APP_URL}\n`,
    html: `<p><strong>${escapeHtmlBasic(senderLabel)}</strong> sent a message on <strong>${escapeHtmlBasic(item.text)}</strong>:</p><p>"${escapeHtmlBasic(trimmed)}"</p><p><a href="${APP_URL}">Open your to-do list</a></p>`,
  }).catch((e) => { console.error('[addDelegateMessage] notification email failed:', e && e.message); }); // never fail the save because the notification email failed

  return item;
}

function intervalToDays(interval, customDays) {
  if (interval === 'Weekly') return 7;
  if (interval === 'Monthly') return 30;
  if (interval === 'Custom') return customDays && customDays > 0 ? customDays : 1;
  return 1; // 'Daily' or unset
}

function daysBetween(isoDateA, isoDateB) {
  const a = new Date(isoDateA + 'T00:00:00Z').getTime();
  const b = new Date(isoDateB + 'T00:00:00Z').getTime();
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// Scheduled sweep (see api/cron/nudge-delegates.js) — finds every delegated,
// still-unchecked item with Nudge Mode = Auto whose interval has elapsed
// since its last nudge (or since it was first delegated, if never nudged),
// sends the reminder, and stamps Delegate Last Nudge to today. Deliberately
// plain, deterministic code (not an AI agent decision) — same reasoning as
// the instant @todo tag handling above: this is Elazar's own standing
// instruction ("auto-nudge every N days"), not a new send decided on the fly.
async function autoNudgeSweep() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const all = await listDelegatedItems();
  const due = all.filter((it) => {
    if (it.checked) return false;
    if (it.nudgeMode !== 'Auto') return false;
    const baseline = it.delegateLastNudge || it.delegatedAt;
    if (!baseline) return true; // no baseline at all — safe to nudge now
    const intervalDays = intervalToDays(it.nudgeInterval, it.nudgeCustomDays);
    return daysBetween(baseline, todayISO) >= intervalDays;
  });

  const results = [];
  for (const item of due) {
    try {
      const contactsMap = await getContactsByIds(item.delegatedToIds);
      const completedIds = item.delegateMode === 'All' ? (item.delegateCompletedByIds || []) : [];
      const pendingIds = item.delegatedToIds.filter((id) => !completedIds.includes(id));
      if (!pendingIds.length) { results.push({ item: item.text, skipped: true, reason: 'everyone already completed their part' }); continue; }
      for (const id of pendingIds) {
        const contact = contactsMap[id];
        if (!contact) { results.push({ item: item.text, skipped: true, reason: 'contact not found' }); continue; }
        const sendResult = await sendDelegateInvite(item, contact);
        results.push({ item: item.text, contact: contact.name, ...sendResult });
      }
      await updateItem(item.recordId, { delegateLastNudge: todayISO });
    } catch (err) {
      results.push({ item: item.text, error: err.message });
    }
  }
  return { checked: all.length, dueCount: due.length, results };
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
  listContacts,
  searchContacts,
  createContact,
  listDelegatedItems,
  listItemsForContact,
  nudgeDelegatedItem,
  autoNudgeSweep,
  markDelegateComplete,
  addDelegateMessage,
};
