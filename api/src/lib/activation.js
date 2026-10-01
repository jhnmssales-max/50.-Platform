// The new-dealer activation gate: whether a tenant's staff may use the
// dealer page and the staff API yet. Pure decision logic — the data comes
// from db.js's getCallerContext (one row per request, already RLS-scoped),
// and getCallerContext is also where it's enforced, so every staff route
// that resolves its caller is gated by default rather than by remembering
// to opt in (see that function's own comment).
const { stripeKeyMode } = require('./stripe');

// Returns { required, reason }:
//   - billing_exempt: tenants.billing_required is false (Good Steward
//     Structures, North Mountain Structures, 50. itself). Never gated.
//     Only an explicit false counts — anything else (true, or a value a
//     future query forgot to select) is treated as billing-required, so a
//     mistake here fails closed, never open.
//   - not_paid: billing-required and no activation payment has ever been
//     confirmed by Stripe's webhook (activation_paid_at is only ever set
//     by routes/webhooks.js — never by a Checkout redirect/return).
//   - activated: confirmed by a live-mode payment. Counts everywhere.
//   - activated_test_mode: confirmed by a Stripe test-mode payment (or one
//     recorded before livemode was tracked). Counts only while this API
//     itself runs on a test key — on a live key (or no usable key at
//     all) it does not, so nothing done in test mode, or against a
//     stand-in, can ever unlock a real tenant. That's this gate's half of
//     the assertRealStripeConfigured() safety pattern (lib/stripe.js).
function activationState(ctx, keyMode = stripeKeyMode()) {
  if (ctx.billing_required === false) return { required: false, reason: 'billing_exempt' };
  if (!ctx.activation_paid_at) return { required: true, reason: 'not_paid' };
  if (ctx.activation_livemode === true) return { required: false, reason: 'activated' };
  if (keyMode === 'test') return { required: false, reason: 'activated_test_mode' };
  return { required: true, reason: 'test_mode_activation_not_valid_live' };
}

// 402 Payment Required, with a machine-readable code the dealer page
// keys off (server.js's error handler forwards publicCode). Names no
// Stripe detail — the staff member seeing this only needs to know who
// can fix it.
function activationRequiredError(ctx) {
  const err = new Error(
    `${ctx.tenant_name} hasn't completed its one-time 50. activation yet. ` +
      'An admin on this account needs to sign in and finish activation before it can be used.'
  );
  err.status = 402;
  err.publicCode = 'activation_required';
  return err;
}

module.exports = { activationState, activationRequiredError };
