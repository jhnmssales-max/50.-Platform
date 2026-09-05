// Minimal Postmark client — no SDK dependency, just fetch (built into
// Node 22). POSTMARK_API_BASE is overridable so tests can point this at a
// local stand-in instead of the real api.postmarkapp.com, the same
// approach used throughout this project for Supabase's auth schema.
const POSTMARK_API_BASE = process.env.POSTMARK_API_BASE || 'https://api.postmarkapp.com';

// Throws on any failure — including one Postmark accepts over HTTP but
// flags internally (a non-zero ErrorCode in a 200 response, e.g. an
// inactive/bounced recipient) — so callers get one consistent failure
// path to handle rather than checking two different shapes of "it didn't
// work."
async function sendEmail({ from, to, subject, htmlBody, textBody }) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    throw new Error('POSTMARK_SERVER_TOKEN is not set — see .env.example');
  }

  const res = await fetch(`${POSTMARK_API_BASE}/email`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      TextBody: textBody,
      MessageStream: 'outbound',
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok || (body.ErrorCode !== undefined && body.ErrorCode !== 0)) {
    const err = new Error(body.Message || `Postmark request failed (${res.status})`);
    err.postmarkErrorCode = body.ErrorCode;
    throw err;
  }

  return { messageId: body.MessageID };
}

module.exports = { sendEmail };
