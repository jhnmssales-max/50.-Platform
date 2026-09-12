// Stand-in gift card provider. Issues nothing real — just returns a
// fake provider_transaction_id — so the reward-issuance worker (claim a
// gift_card_transactions row, call the provider, record the result) is
// fully exercisable end to end before any real provider contract exists.
// See ../giftCardProvider.js for why this indirection exists at all.
//
// Test-only escape hatch: GIFT_CARD_STUB_FAIL_KEYS is a comma-separated
// list of idempotencyKey values (e.g. "<referral-id>:new_customer") this
// stub deliberately rejects, so the "charge succeeded but issuance
// failed" -> billing_events.needs_refund path can be exercised on demand
// without a real provider to fail against. Unset (the default) means
// every call succeeds. Never set in production — there would be nothing
// real to fail against there anyway.
let counter = 0;

async function issueGiftCard({ amountCents, currency, recipientEmail, idempotencyKey }) {
  const forcedFailures = (process.env.GIFT_CARD_STUB_FAIL_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (forcedFailures.includes(idempotencyKey)) {
    throw new Error(`Stub gift card provider: forced failure for idempotency key "${idempotencyKey}" (GIFT_CARD_STUB_FAIL_KEYS)`);
  }

  counter += 1;
  return {
    providerTransactionId: `stub_gc_${counter}_${idempotencyKey}`,
    raw: { amountCents, currency, recipientEmail, idempotencyKey, stub: true },
  };
}

module.exports = { issueGiftCard };
