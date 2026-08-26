require('dotenv').config();
const express = require('express');
const customersRouter = require('./routes/customers');
const referralsRouter = require('./routes/referrals');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', customersRouter);
app.use('/api', referralsRouter);

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
