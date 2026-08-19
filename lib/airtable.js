const BASE_ID = 'apptn2yEy7TRhdkNm';
const TABLE_ID = 'tbl5YWY1ZJkyQFqwA';

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
    type: f[FIELDS.type] || 'task',
    text: f[FIELDS.text] || '',
    meta: f[FIELDS.meta] || '',
    link: f[FIELDS.link] || '',
    checked: !!f[FIELDS.checked],
    urgent: !!f[FIELDS.urgent],
    updatedAt: f[FIELDS.updatedAt] || '',
  };
}

async function listItems() {
  let records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtableFetch(`/${TABLE_ID}?${qs.toString()}`);
    records = records.concat(page.records || []);
    offset = page.offset;
  } while (offset);

  return records
    .map(recordToItem)
    // Hide internal heartbeat/connectivity status rows — not real to-do items
    .filter((item) => !/^status_/.test(item.id));
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
    body: JSON.stringify({ records: [{ fields }] }),
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
  if (data.checked !== undefined) fields[FIELDS.checked] = !!data.checked;
  fields[FIELDS.updatedAt] = new Date().toISOString();

  const result = await airtableFetch(`/${TABLE_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: recordId, fields }] }),
  });
  return recordToItem(result.records[0]);
}

async function deleteItem(recordId) {
  await airtableFetch(`/${TABLE_ID}?records[]=${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
  });
  return { ok: true };
}

module.exports = { listItems, createItem, updateItem, deleteItem };
