const { isAuthenticated } = require('../lib/auth');
const { getMonthSummary, getDayItems, reopenSnapshotItem } = require('../lib/airtable');

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Not logged in' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://internal');
      const month = url.searchParams.get('month'); // "YYYY-MM"
      const date = url.searchParams.get('date'); // "YYYY-MM-DD"

      if (date) {
        const items = await getDayItems(date);
        res.status(200).json({ ok: true, date, items });
        return;
      }
      if (month) {
        const days = await getMonthSummary(month);
        res.status(200).json({ ok: true, month, days });
        return;
      }
      res.status(400).json({ ok: false, error: 'Provide ?month=YYYY-MM or ?date=YYYY-MM-DD' });
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
      const { action, date, itemId, note } = body;
      if (action === 'reopen') {
        if (!date || !itemId) {
          res.status(400).json({ ok: false, error: 'date and itemId are required' });
          return;
        }
        if (!note || !String(note).trim()) {
          res.status(400).json({ ok: false, error: 'A note explaining the reopen is required' });
          return;
        }
        const item = await reopenSnapshotItem(date, itemId, note);
        res.status(200).json({ ok: true, item });
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
