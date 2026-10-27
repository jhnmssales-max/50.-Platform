// Remembering whether a referral email actually reached somebody.
//
// Postmark refuses a suppressed address rather than silently dropping it: a
// non-zero ErrorCode comes back, which lib/postmark.js turns into a throw.
// Until now every caller logged that and moved on, so the knowledge died in
// a log file nobody reads -- and a dealer went on believing a customer was
// in their referral program when nothing had reached them for weeks.
//
// Recorded outside any transaction, deliberately. Sending already happens
// after the rows are committed, and the record of how it went must not be
// able to roll back the customer it describes.
const { withServiceRole } = require('../db');

// Postmark's "inactive recipient": the address is on the suppression list
// because it hard-bounced or someone marked a message as spam. Every later
// send to it is refused. This is the one worth telling a dealer about --
// unlike a timeout, it will not fix itself.
const INACTIVE_RECIPIENT = 406;

function describe(err) {
  if (!err) return null;
  if (err.postmarkErrorCode === INACTIVE_RECIPIENT) {
    return 'This address has bounced before, so nothing more can be delivered to it.';
  }
  const msg = String(err.message || 'The mail provider refused this message.');
  return msg.length > 200 ? msg.slice(0, 197) + '…' : msg;
}

// `err` null means it went through. Clearing on success matters as much as
// setting on failure: an address the dealer has since corrected should stop
// being flagged, and a flag that only ever accumulates becomes noise a
// dealer learns to scroll past.
async function noteDeliveryOutcome(customerId, err) {
  if (!customerId) return;
  try {
    await withServiceRole((client) =>
      err
        ? client.query(
            'update customers set delivery_failed_at = now(), delivery_error = $2 where id = $1',
            [customerId, describe(err)]
          )
        : client.query(
            'update customers set delivery_failed_at = null, delivery_error = null where id = $1 and delivery_failed_at is not null',
            [customerId]
          )
    );
  } catch (writeErr) {
    // Best effort by design. Failing to record how a send went must never
    // turn into a second failure on top of the first.
    console.error(`Could not record delivery outcome for customer ${customerId}: ${writeErr.message}`);
  }
}

module.exports = { noteDeliveryOutcome, describe, INACTIVE_RECIPIENT };
