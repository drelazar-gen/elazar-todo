// Elazar's own private contacts endpoint — powers the "@todo delegate to"
// search/add-new picker in the app (see app.js's todo-menu delegate flow).
// Requires login, same as api/items.js. NOT the same thing as api/delegate.js
// (that one is the public, token-gated portal for a contact themselves).
const { isAuthenticated } = require('../lib/auth');
const { searchContacts, createContact } = require('../lib/airtable');

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Not logged in' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://internal').searchParams.get('q') || '';
      const contacts = await searchContacts(q);
      res.status(200).json({ ok: true, contacts });
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
        const contact = await createContact(body);
        res.status(200).json({ ok: true, contact });
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
