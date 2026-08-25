// Token-gated portal API for people Elazar delegates items to. No password —
// the unguessable Access Token in the link (?t=...) IS the credential. Never
// return anything beyond what that one contact needs: their name and the
// items delegated to them. Never expose their email/phone/token back to
// themselves either — no reason to, and it avoids echoing the token anywhere
// but the URL itself.
const { getContactByToken, listItemsForContact, markDelegateComplete } = require('../lib/airtable');

// `contactRecordId` is whichever contact is viewing (from their own token) —
// used to compute per-person completion state for "All" mode group items,
// without ever exposing who ELSE it's delegated to (this contact only sees
// their own progress, not other delegates' names).
function publicItem(it, contactRecordId) {
  const isGroupAll = it.delegateMode === 'All' && (it.delegatedToIds || []).length > 1;
  const completedIds = it.delegateCompletedByIds || [];
  return {
    recordId: it.recordId,
    text: it.text,
    meta: it.meta,
    link: it.link,
    section: it.section,
    checked: it.checked,
    urgent: it.urgent,
    delegateMode: it.delegateMode || 'Any',
    isGroup: (it.delegatedToIds || []).length > 1,
    // For a group "All" item: whether THIS contact has completed their own
    // copy, and how many of the group (of how many total) are done so far.
    // For everything else, myCompleted just mirrors the shared checked state.
    myCompleted: isGroupAll ? completedIds.includes(contactRecordId) : it.checked,
    groupCompletedCount: isGroupAll ? completedIds.length : undefined,
    groupTotalCount: isGroupAll ? (it.delegatedToIds || []).length : undefined,
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
      res.status(200).json({ ok: true, contact: { name: contact.name }, items: items.map((it) => publicItem(it, contact.recordId)) });
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
      // In a group "All" item this marks only THIS contact's own copy
      // complete (and only flips the shared item once everyone has); for
      // everything else it behaves exactly like the old direct toggle.
      const item = await markDelegateComplete(recordId, contact.recordId, !!checked);
      res.status(200).json({ ok: true, item: publicItem(item, contact.recordId) });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};
