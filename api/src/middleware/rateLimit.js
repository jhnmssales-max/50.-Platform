const rateLimit = require('express-rate-limit');

// These are the only unauthenticated routes in the API — anyone on the
// internet can hit them, so every one gets its own limiter rather than a
// single shared budget. Limits are per IP, in-memory: fine for a single
// API instance, but note this does NOT hold once the service is scaled
// to multiple instances — that needs a shared store (e.g. Redis) behind
// express-rate-limit's external-store option, not a code change here.
//
// The API sits behind a proxy/load balancer in any real deployment, so
// IP-based limiting is only meaningful once `app.set('trust proxy', ...)`
// is configured correctly for that deployment — see server.js.
function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

// A visitor loading the customer/lead page triggers one call; generous
// headroom for reloads and retries without meaningfully helping someone
// brute-force codes (each attempt still costs a request).
const resolveLinkLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many requests. Try again in a minute.',
});

// The prototype's own copy says tapping "share" again always makes a new
// link, so a real customer may legitimately do this a handful of times.
const createShareLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many links requested. Try again in a minute.',
});

// The tightest limit: this is the actual lead-capture write, and the one
// an abuser gains the most from hitting repeatedly.
const submitReferralLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many submissions. Try again in a minute.',
});

module.exports = { resolveLinkLimiter, createShareLimiter, submitReferralLimiter };
