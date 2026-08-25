// Daily scheduled sweep (see /vercel.json's "crons" entry) — sends
// auto-nudge reminder emails for delegated, still-unchecked items whose
// Nudge Mode is "Auto" and whose interval has come due. Plain deterministic
// code, not an AI agent decision — Elazar opted each item into this
// explicitly via the delegate popup's nudge-interval picker.
//
// Optional lock-down: set a CRON_SECRET env var in Vercel and this endpoint
// will require it (as `Authorization: Bearer <secret>` — which Vercel Cron
// sends automatically once CRON_SECRET is set — or as a `?secret=` query
// param, for an external pinger like cron-job.org as a fallback). Until
// CRON_SECRET is set, this endpoint runs open — it only ever sends emails to
// contacts Elazar himself already delegated to with auto-nudge turned on, so
// that's a low-risk default, not a real secret-holding endpoint.
const { autoNudgeSweep } = require('../../lib/airtable');

module.exports = async (req, res) => {
  const configuredSecret = process.env.CRON_SECRET;
  if (configuredSecret) {
    const authHeader = req.headers.authorization || '';
    const queryParam = new URL(req.url, 'http://internal').searchParams.get('secret');
    const ok = authHeader === `Bearer ${configuredSecret}` || queryParam === configuredSecret;
    if (!ok) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  try {
    const result = await autoNudgeSweep();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};
