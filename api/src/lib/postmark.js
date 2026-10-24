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
// replyTo is optional. Every tenant without its own verified domain sends
// from the platform's one shared address (EMAIL_FROM_ADDRESS), so without a
// Reply-To a customer hitting "Reply" would land in that shared inbox
// instead of the business's own — pass the business's address here.
// headers is optional: a list of { Name, Value }. Used for List-Unsubscribe,
// which is what lets a mail client show its own "unsubscribe" control and
// what the big providers look for before deciding a recurring sender is
// legitimate. Worth having on referral mail now that some of it repeats.
async function sendEmail({ from, to, cc, replyTo, subject, htmlBody, textBody, headers }) {
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
      ...(cc ? { Cc: cc } : {}),
      ...(replyTo ? { ReplyTo: replyTo } : {}),
      ...(headers && headers.length ? { Headers: headers } : {}),
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
