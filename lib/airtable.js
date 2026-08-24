const BASE_ID = 'apptn2yEy7TRhdkNm';
const TABLE_ID = 'tbl5YWY1ZJkyQFqwA';
const SNAP_TABLE_ID = 'tblN363yqJug43X4L';
const HEARTBEAT_TABLE_ID = 'tblmmZ3d2aXGxz9Xw'; // "Heartbeat Findings" — written by the Chrome extension

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
  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true }),
  });
  return recordToItem(result.records[0]);
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
    }
  }
  fields[FIELDS.updatedAt] = new Date().toISOString();

  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: recordId, fields }], returnFieldsByFieldId: true }),
  });
  return recordToItem(result.records[0]);
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
};
