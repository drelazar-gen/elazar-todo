const BASE_ID = 'apptn2yEy7TRhdkNm';
const TABLE_ID = 'tbl5YWY1ZJkyQFqwA';
const SNAP_TABLE_ID = 'tblN363yqJug43X4L';

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

// The heartbeat automation stamps two rows (status_whatsapp_check /
// status_messages_check) every time it checks WhatsApp/Messages. Surface
// those timestamps so the page can show "last checked" like the old doc did.
async function getStatus() {
  const all = await fetchAllRecords();
  const map = {};
  all.forEach((item) => {
    if (/^status_/.test(item.id)) map[item.id] = item.updatedAt || null;
  });
  return {
    whatsapp: map['status_whatsapp_check'] || null,
    messages: map['status_messages_check'] || null,
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
    if (data.checked) fields[FIELDS.carriedOver] = false;
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
// since deleted from the live list.
async function reopenSnapshotItem(date, itemId) {
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
    return updateItem(live.recordId, { checked: false });
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
    [FIELDS.meta]: (snap && snap.meta) || '',
    [FIELDS.link]: '',
    [FIELDS.checked]: false,
    [FIELDS.urgent]: (snap && snap.urgent) || false,
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
  getMonthSummary,
  getDayItems,
  reopenSnapshotItem,
};
