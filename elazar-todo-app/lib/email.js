// Thin wrapper around Resend's HTTP API. No-ops (returns {skipped:true})
// until RESEND_API_KEY is set as a Vercel env var — so delegate invites and
// nudges simply don't send yet, rather than crashing the app, while Elazar
// finishes that one-time setup. Once configured, this is the ONLY thing
// that ever actually sends mail to a contact — it's plain deterministic
// code the app runs itself, not an AI agent deciding to send on its own.

async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { skipped: true, reason: 'RESEND_API_KEY not configured yet' };
  }
  const from = process.env.RESEND_FROM || "Elazar's To-Do List <onboarding@resend.dev>";
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body && (body.message || JSON.stringify(body.error))) || `Resend request failed (${res.status})`);
  }
  return { sent: true, id: body.id };
}

module.exports = { sendEmail };
