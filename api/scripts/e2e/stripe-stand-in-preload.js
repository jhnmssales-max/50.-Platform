// Test-only. Loaded into the API process by the e2e runner, and nowhere
// else:
//
//   node -r ./scripts/e2e/stripe-stand-in-preload.js src/server.js
//
// Redirects fetch calls bound for Stripe's real API
// (https://api.stripe.com/v1/...) to the local stand-in at
// STRIPE_STAND_IN_URL. This is deliberately *below* lib/stripe.js's
// configuration rather than through STRIPE_API_BASE: the API itself is
// configured exactly as a real deployment is (real base URL, a test-mode
// key), so assertRealStripeConfigured() passes for the right reason, and
// no configuration a real deployment could carry can ever point it at a
// stand-in. `npm start` (what Render runs) never loads this file.
//
// Refuses to load next to a live-mode key — a stand-in has no business
// in the same process as real money.
const REAL_STRIPE_API_BASE = 'https://api.stripe.com/v1';

const key = process.env.STRIPE_SECRET_KEY || '';
if (/^(sk|rk)_live_/.test(key)) {
  console.error('stripe-stand-in-preload: refusing to load — STRIPE_SECRET_KEY is a LIVE key. The stand-in is for test-mode keys only.');
  process.exit(1);
}

const target = (process.env.STRIPE_STAND_IN_URL || '').replace(/\/$/, '');
if (!target) {
  console.error('stripe-stand-in-preload: STRIPE_STAND_IN_URL is not set.');
  process.exit(1);
}

const realFetch = globalThis.fetch;
globalThis.fetch = function fetchWithStripeStandIn(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(REAL_STRIPE_API_BASE)) {
    return realFetch(`${target}${url.slice(REAL_STRIPE_API_BASE.length)}`, init);
  }
  return realFetch(input, init);
};

console.warn(`[e2e] Stripe stand-in preload active: calls to ${REAL_STRIPE_API_BASE} from this process go to ${target} (test-only).`);
