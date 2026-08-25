const { createSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
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

  const expected = process.env.PAGE_PASSWORD;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'Server is not configured (PAGE_PASSWORD missing)' });
    return;
  }

  if (!body.password || body.password !== expected) {
    res.status(401).json({ ok: false, error: 'Wrong password' });
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie());
  res.status(200).json({ ok: true });
};
