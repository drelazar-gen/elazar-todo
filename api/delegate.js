// Token-gated portal API for people Elazar delegates items to. No password —
// the unguessable Access Token in the link (?t=...) IS the credential. Never
// return anything beyond what that one contact needs: their name and the
// items delegated to them. Never expose their email/phone/token back to
// themselves either — no reason to, and it avoids echoing the token anywhere
// but the URL itself.
const { getContactByToken, listItemsForContact, updateItem } = require('../lib/airtable');

function publicItem(it) {
  return {
    recordId: it.recordId,
    text: it.text,
    meta: it.meta,
    link: it.link,
    section: it.section,
    checked: it.checked,
    urgent: it.urgent,
  };
}

module.exports = async (req, res) => {
  try {
    let body = {};
    if (req.method === 'POST') {
      body = req.body;
      if (!body || typeof body === 'string') {
        try {
          body = JSON.parse(body || '{}');
        } catch (e) {
          body = {};
        }
      }
    }

    const token = req.method === 'GET' ? new URL(req.url, 'http://internal').searchParams.get('t') : body.t;
    if (!token) {
      res.status(400).json({ ok: false, error: 'Missing token' });
      return;
    }

    const contact = await getContactByToken(String(token));
    if (!contact) {
      res.status(404).json({ ok: false, error: 'Link not recognized. Ask Elazar for a fresh link.' });
      return;
    }

    if (req.method === 'GET') {
      const items = await listItemsForContact(contact.recordId);
      res.status(200).json({ ok: true, contact: { name: contact.name }, items: items.map(publicItem) });
      return;
    }

    if (req.method === 'POST') {
      const { action, recordId, checked } = body;
      if (action !== 'toggle' || !recordId) {
        res.status(400).json({ ok: false, error: 'Unknown action' });
        return;
      }
      // Security check: only allow toggling an item actually delegated to
      // THIS contact — never trust recordId alone, a guessed/other id must
      // not be toggleable through this token.
      const theirs = await listItemsForContact(contact.recordId);
      const owns = theirs.some((it) => it.recordId === recordId);
      if (!owns) {
        res.status(403).json({ ok: false, error: 'Not your item' });
        return;
      }
      const item = await updateItem(recordId, { checked: !!checked });
      res.status(200).json({ ok: true, item: publicItem(item) });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};
