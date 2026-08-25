const { isAuthenticated } = require('../lib/auth');
const { listItems, createItem, updateItem, deleteItem, getStatus, nudgeDelegatedItem } = require('../lib/airtable');

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Not logged in' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const [items, status] = await Promise.all([listItems(), getStatus()]);
      res.status(200).json({ ok: true, items, status });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch (e) {
        body = {};
      }
    }

    if (req.method === 'POST') {
      const { action } = body;

      if (action === 'create') {
        const item = await createItem(body);
        res.status(200).json({ ok: true, item });
        return;
      }

      if (action === 'toggle') {
        const item = await updateItem(body.recordId, { checked: body.checked, archived: body.archived });
        res.status(200).json({ ok: true, item });
        return;
      }

      if (action === 'update') {
        const item = await updateItem(body.recordId, body);
        res.status(200).json({ ok: true, item });
        return;
      }

      if (action === 'delete') {
        await deleteItem(body.recordId);
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'nudge') {
        const result = await nudgeDelegatedItem(body.recordId);
        res.status(200).json({ ok: true, result });
        return;
      }

      res.status(400).json({ ok: false, error: 'Unknown action' });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};
