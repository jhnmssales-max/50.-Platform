require('dotenv').config();
const express = require('express');
const customersRouter = require('./routes/customers');
const referralsRouter = require('./routes/referrals');
const publicRouter = require('./routes/public');
const meRouter = require('./routes/me');
const tenantSettingsRouter = require('./routes/tenantSettings');

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

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', customersRouter);
app.use('/api', referralsRouter);
app.use('/api', publicRouter);
app.use('/api', meRouter);
app.use('/api', tenantSettingsRouter);

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
