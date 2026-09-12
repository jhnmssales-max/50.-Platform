require('dotenv').config();
const path = require('path');
const express = require('express');
const customersRouter = require('./routes/customers');
const referralsRouter = require('./routes/referrals');
const publicRouter = require('./routes/public');
const meRouter = require('./routes/me');
const tenantSettingsRouter = require('./routes/tenantSettings');
const billingRouter = require('./routes/billing');
const webhooksRouter = require('./routes/webhooks');

const app = express();

// The public routes are IP-rate-limited, which is only meaningful behind
// a proxy/load balancer if Express is told to trust its X-Forwarded-For
// header — and only safe to trust when that's actually true, since a
// spoofed header otherwise lets a caller pick their own rate-limit
// bucket. Set TRUST_PROXY to the number of proxy hops in front of this
// service (Render's own proxy = 1) in production; leave unset locally.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

// Mounted before express.json(), not after: Stripe's webhook signature
// covers the exact raw bytes of the request body, and routes/webhooks.js
// applies its own express.raw() to that one path. If express.json() ran
// first, the raw bytes would already be gone by the time the webhook
// route saw the request, and verification would fail on every real
// Stripe delivery — this ordering is what actually prevents that, not
// just the raw() call in isolation.
app.use('/api', webhooksRouter);

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Plain, minimal, static — the two pages Stripe Checkout redirects back
// to after the activation charge (see routes/billing.js). Served by
// this same app rather than wherever the tenant-branded frontend pages
// happen to be hosted, so they need no extra deployment config or
// coordination with FRONTEND_BASE_URL.
app.use('/billing', express.static(path.join(__dirname, '..', 'public', 'billing')));

app.use('/api', customersRouter);
app.use('/api', referralsRouter);
app.use('/api', publicRouter);
app.use('/api', meRouter);
app.use('/api', tenantSettingsRouter);
app.use('/api', billingRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler. Only intentionally-thrown errors (with a
// .status) get their message sent to the client; anything else is logged
// server-side and reported generically, so a stray SQL/driver error never
// leaks internal detail to an API caller.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(status).json({ error: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`referral-platform-api listening on :${port}`);
});
