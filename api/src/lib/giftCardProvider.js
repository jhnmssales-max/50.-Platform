// Provider-agnostic interface for issuing a single gift card. Exactly
// one function — issueGiftCard(...) resolves to
// { providerTransactionId, raw } or throws — so the reward-issuance
// worker (workers/rewardIssuance.js) calls only this module, never a
// specific provider's client directly. Dropping in a real provider once
// one exists means adding one file under ./giftCardProviders that
// exports the same issueGiftCard(...) shape and pointing
// GIFT_CARD_PROVIDER at its name — the worker itself never changes.
//
// As of this writing there is no real platform-funded gift card provider
// to integrate: Tremendous declined to support this model, and Tango /
// Amazon Incentives are both pending the business paperwork (an LLC and
// an EIN) needed to open an account. Only 'stub' exists below.
//
// This is deliberately separate from lib/tremendous.js, which is a real,
// working integration — but for a different relationship entirely: it
// funds a reward from the *tenant's own* connected Tremendous account
// (see routes/referrals.js's manual PATCH .../status 'rewarded' flow),
// the pre-Stripe-billing model where every tenant pays for its own
// rewards directly. Under the model Stage 4 implements, the platform
// charges the tenant via Stripe and then the *platform itself* funds and
// issues the reward from its own provider account — a tenant's
// Tremendous credentials (or lack of them) are irrelevant to this path,
// so lib/tremendous.js is never called from here.
const PROVIDER = process.env.GIFT_CARD_PROVIDER || 'stub';

const providers = {
  stub: require('./giftCardProviders/stub'),
};

function getProvider() {
  const provider = providers[PROVIDER];
  if (!provider) {
    throw new Error(`Unknown GIFT_CARD_PROVIDER "${PROVIDER}" — available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

// idempotencyKey must be unique per (referral, recipient role) forever —
// see workers/rewardIssuance.js's leg keys, "<referral-id>:referrer" and
// "<referral-id>:new_customer", matching the format
// routes/referrals.js's existing manual flow already uses for the
// referrer leg. referralId/recipientRole are passed through only for a
// provider (or the stub) that wants to log/attribute by them — the
// idempotency guarantee itself lives entirely in idempotencyKey.
async function issueGiftCard({ amountCents, currency, recipientName, recipientEmail, idempotencyKey, referralId, recipientRole }) {
  return getProvider().issueGiftCard({
    amountCents,
    currency,
    recipientName,
    recipientEmail,
    idempotencyKey,
    referralId,
    recipientRole,
  });
}

module.exports = { issueGiftCard };
