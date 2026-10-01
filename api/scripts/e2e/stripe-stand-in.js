// Test-only. A local stand-in for the slice of Stripe this API uses —
// Checkout Sessions (plus a hosted "checkout page" a browser can actually
// pay on), off-session PaymentIntents, and signed webhook delivery — so
// the activation gate and the referral usage fee can be exercised end to
// end, in a real browser, without network access to Stripe.
//
// It is NOT how this path gets verified against real Stripe: that's
// `activation-gate-e2e.js --stripe=test` with a real sk_test_ key. This
// exists so everything up to that point is proven first.
//
// The API never reaches this through configuration — lib/stripe.js's
// assertRealStripeConfigured() refuses any STRIPE_API_BASE other than
// Stripe's own. The e2e runner loads stripe-stand-in-preload.js into the
// API process instead, which redirects fetch calls bound for
// https://api.stripe.com below the config.
//
// Faithful where this API depends on Stripe's behavior, and stricter than
// Stripe wherever that's in doubt:
//   - only sk_test_ keys are accepted (401 otherwise);
//   - customer and customer_creation are mutually exclusive (400);
//   - a completed Checkout Session only gets a Customer when
//     customer_creation: 'always' (or customer) was sent — so a request
//     that forgot it produces an unchargeable payment method here;
//   - an off-session PaymentIntent needs a payment method attached to the
//     given customer;
//   - Idempotency-Key: same key + same parameters replays the original
//     response (status and body, a decline included); same key +
//     different parameters is a 400 idempotency_error;
//   - livemode is always false (test mode);
//   - webhooks are signed with Stripe's documented scheme
//     (t=<unix>,v1=HMAC-SHA256(secret, "<t>.<payload>")) and delivered
//     asynchronously, after the browser has already been redirected back
//     — the order real Stripe doesn't guarantee either.
const crypto = require('crypto');
const express = require('express');

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function formatMoney(cents, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function createStripeStandIn({ publicBaseUrl, webhookUrl, webhookSecret, webhookDelayMs = 400 }) {
  const state = {
    sessions: new Map(),
    paymentIntents: new Map(),
    customers: new Map(),
    paymentMethods: new Map(),
    idempotency: new Map(),
    events: new Map(),
    requests: [],
    deliveries: [],
    heldEvents: [],
    holdWebhooks: false,
    dropNextResponses: 0,
  };

  const app = express();

  function stripeError(res, status, error) {
    return res.status(status).json({ error });
  }

  // ---- API surface (/v1) ----------------------------------------------
  app.use('/v1', express.urlencoded({
    extended: true,
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  app.use('/v1', (req, res, next) => {
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: req.path,
      idempotencyKey: req.get('idempotency-key') || null,
      body: req.body && Object.keys(req.body).length ? req.body : null,
      status: null,
    };
    state.requests.push(entry);
    res.on('finish', () => { entry.status = res.statusCode; });
    res.on('close', () => { if (entry.status === null) entry.status = 'connection-dropped'; });

    const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
    if (!match) {
      return stripeError(res, 401, { type: 'invalid_request_error', message: 'You did not provide an API key.' });
    }
    if (!/^sk_test_/.test(match[1])) {
      return stripeError(res, 401, {
        type: 'invalid_request_error',
        message: 'Invalid API Key provided: this local stand-in only accepts test-mode secret keys (sk_test_...).',
      });
    }
    next();
  });

  // Stripe's Idempotency-Key contract: same key + same parameters replays
  // the first response (status and body, errors included); same key +
  // different parameters is a 400 idempotency_error. Returns true when it
  // has already answered.
  function replayIdempotent(req, res) {
    const key = req.get('idempotency-key');
    if (!key) return false;
    const paramsHash = crypto.createHash('sha256').update(`${req.path}\n${req.rawBody || ''}`).digest('hex');
    const cached = state.idempotency.get(key);
    if (!cached) {
      req.idempotency = { key, paramsHash };
      return false;
    }
    if (cached.paramsHash !== paramsHash) {
      stripeError(res, 400, {
        type: 'idempotency_error',
        message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
      });
      return true;
    }
    res.set('Idempotent-Replayed', 'true');
    res.status(cached.status).json(cached.body);
    return true;
  }

  function rememberIdempotent(req, status, body) {
    if (req.idempotency) state.idempotency.set(req.idempotency.key, { paramsHash: req.idempotency.paramsHash, status, body });
  }

  app.post('/v1/checkout/sessions', (req, res) => {
    if (replayIdempotent(req, res)) return;
    const b = req.body || {};
    const invalid = (message, param) => {
      const body = { error: { type: 'invalid_request_error', message, param } };
      rememberIdempotent(req, 400, body);
      return res.status(400).json(body);
    };

    if (!['payment', 'setup', 'subscription'].includes(b.mode)) return invalid('Invalid mode', 'mode');
    if (b.mode !== 'payment') return invalid('This stand-in only implements mode=payment', 'mode');
    if (!b.success_url) return invalid('Missing required param: success_url.', 'success_url');
    if (b.customer && b.customer_creation) {
      return invalid('You may only specify one of these parameters: customer, customer_creation.', 'customer_creation');
    }
    if (b.customer_creation && !['always', 'if_required'].includes(b.customer_creation)) {
      return invalid('Invalid customer_creation', 'customer_creation');
    }
    if (b.customer && !state.customers.has(b.customer)) {
      return invalid(`No such customer: '${b.customer}'`, 'customer');
    }
    const types = b.payment_method_types || ['card'];
    if (!types.every((t) => ['card', 'us_bank_account'].includes(t))) return invalid('Invalid payment_method_types', 'payment_method_types');
    const pid = b.payment_intent_data || {};
    if (pid.setup_future_usage && !['on_session', 'off_session'].includes(pid.setup_future_usage)) {
      return invalid('Invalid setup_future_usage', 'payment_intent_data[setup_future_usage]');
    }
    const items = b.line_items || [];
    if (!items.length) return invalid('line_items is required in payment mode', 'line_items');

    let amountTotal = 0;
    let currency = null;
    for (const item of items) {
      const pd = item.price_data || {};
      const unit = Number(pd.unit_amount);
      const qty = Number(item.quantity || 1);
      if (!Number.isInteger(unit) || unit < 50) return invalid('Amount must be at least $0.50 usd', 'line_items[0][price_data][unit_amount]');
      if (!pd.currency) return invalid('Missing currency', 'line_items[0][price_data][currency]');
      currency = pd.currency;
      amountTotal += unit * qty;
    }

    const id = randomId('cs_test');
    const session = {
      id,
      object: 'checkout.session',
      mode: 'payment',
      status: 'open',
      payment_status: 'unpaid',
      url: `${publicBaseUrl}/pay/${id}`,
      amount_total: amountTotal,
      currency,
      client_reference_id: b.client_reference_id || null,
      customer: b.customer || null,
      customer_creation: b.customer_creation || null,
      metadata: b.metadata || {},
      payment_intent: null,
      payment_method_types: types,
      success_url: b.success_url,
      cancel_url: b.cancel_url || null,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      // Not part of Stripe's response — kept here to build the
      // PaymentIntent when the hosted page is paid.
      _paymentIntentData: pid,
      _productName: (items[0].price_data.product_data || {}).name || 'Payment',
    };
    state.sessions.set(id, session);
    // The replay is the creation-time snapshot (status 'open'), exactly
    // as Stripe's is — not the session's current state.
    const body = publicSession(session);
    rememberIdempotent(req, 200, body);
    res.json(body);
  });

  app.get('/v1/checkout/sessions/:id', (req, res) => {
    const session = state.sessions.get(req.params.id);
    if (!session) {
      return stripeError(res, 404, { type: 'invalid_request_error', code: 'resource_missing', message: `No such checkout.session: '${req.params.id}'` });
    }
    res.json(publicSession(session));
  });

  app.get('/v1/payment_intents/:id', (req, res) => {
    const pi = state.paymentIntents.get(req.params.id);
    if (!pi) {
      return stripeError(res, 404, { type: 'invalid_request_error', code: 'resource_missing', message: `No such payment_intent: '${req.params.id}'` });
    }
    res.json(pi);
  });

  app.post('/v1/payment_intents', (req, res) => {
    if (replayIdempotent(req, res)) return;

    const { status, body } = createPaymentIntent(req.body || {});
    rememberIdempotent(req, status, body);

    if (state.dropNextResponses > 0) {
      // The charge above has happened — the caller just never hears back.
      state.dropNextResponses -= 1;
      req.socket.destroy();
      return;
    }
    res.status(status).json(body);
  });

  function createPaymentIntent(b) {
    const invalid = (message, param, code) => ({ status: 400, body: { error: { type: 'invalid_request_error', message, param, code } } });
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount < 50) return invalid('Amount must be at least $0.50 usd', 'amount');
    if (!b.currency) return invalid('Missing required param: currency.', 'currency');
    if (!b.customer || !state.customers.has(b.customer)) return invalid(`No such customer: '${b.customer}'`, 'customer', 'resource_missing');
    const pm = state.paymentMethods.get(b.payment_method);
    if (!pm) return invalid(`No such PaymentMethod: '${b.payment_method}'`, 'payment_method', 'resource_missing');
    if (pm.customer !== b.customer) {
      return invalid(`The provided PaymentMethod ${pm.id} does not belong to Customer ${b.customer}.`, 'payment_method');
    }

    const pi = {
      id: randomId('pi'),
      object: 'payment_intent',
      amount,
      currency: b.currency,
      customer: b.customer,
      payment_method: pm.id,
      description: b.description || null,
      metadata: b.metadata || {},
      confirmation_method: 'automatic',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      status: 'succeeded',
      last_payment_error: null,
    };

    if (b.confirm !== 'true') {
      pi.status = 'requires_confirmation';
      state.paymentIntents.set(pi.id, pi);
      return { status: 200, body: pi };
    }

    if (pm._failOffSession) {
      const error = {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
      };
      pi.status = 'requires_payment_method';
      pi.last_payment_error = { ...error, payment_method: { id: pm.id } };
      state.paymentIntents.set(pi.id, pi);
      emitEvent('payment_intent.payment_failed', pi);
      return { status: 402, body: { error: { ...error, payment_intent: pi } } };
    }

    state.paymentIntents.set(pi.id, pi);
    emitEvent('payment_intent.succeeded', pi);
    return { status: 200, body: pi };
  }

  function publicSession(session) {
    const out = {};
    for (const [k, v] of Object.entries(session)) if (!k.startsWith('_')) out[k] = v;
    return out;
  }

  // ---- hosted checkout page --------------------------------------------
  app.get('/pay/:id', (req, res) => res.send(renderPayPage(state.sessions.get(req.params.id))));

  app.post('/pay/:id', express.urlencoded({ extended: false }), (req, res) => {
    const session = state.sessions.get(req.params.id);
    if (!session || session.status !== 'open') return res.status(409).send(renderPayPage(session));
    const card = String((req.body && req.body.cardNumber) || '').replace(/\D/g, '');
    if (card === '4000000000000002') return res.send(renderPayPage(session, 'Your card was declined.'));
    if (card !== '4242424242424242') return res.send(renderPayPage(session, 'Use a test card: 4242 4242 4242 4242 (succeeds) or 4000 0000 0000 0002 (declines).'));

    // Paid. A Customer exists afterwards only if one was passed in, or
    // customer_creation: 'always' asked for one.
    let customerId = session.customer;
    if (!customerId && session.customer_creation === 'always') {
      customerId = randomId('cus');
      state.customers.set(customerId, { id: customerId, object: 'customer', livemode: false });
    }
    const pm = { id: randomId('pm'), object: 'payment_method', type: 'card', customer: customerId || null, card: { brand: 'visa', last4: '4242' }, livemode: false };
    state.paymentMethods.set(pm.id, pm);
    const pid = session._paymentIntentData || {};
    const pi = {
      id: randomId('pi'),
      object: 'payment_intent',
      amount: session.amount_total,
      currency: session.currency,
      customer: customerId || null,
      payment_method: pm.id,
      setup_future_usage: pid.setup_future_usage || null,
      description: pid.description || null,
      metadata: pid.metadata || {},
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      status: 'succeeded',
    };
    state.paymentIntents.set(pi.id, pi);

    session.status = 'complete';
    session.payment_status = 'paid';
    session.payment_intent = pi.id;
    session.customer = customerId || null;
    emitEvent('checkout.session.completed', publicSession(session));

    res.redirect(303, session.success_url.replace('{CHECKOUT_SESSION_ID}', session.id));
  });

  function renderPayPage(session, error) {
    if (!session) return '<!doctype html><title>Not found</title><h1 id="gone">No such checkout session</h1>';
    const closed = session.status !== 'open';
    return `<!doctype html><html><head><meta charset="utf-8"><title>Checkout — local Stripe stand-in</title>
<style>body{font-family:sans-serif;max-width:420px;margin:40px auto;}#banner{background:#ffde92;padding:6px 10px;font-weight:bold;font-size:12px}#error{color:#b00}</style></head><body>
<div id="banner">TEST MODE — local Stripe stand-in (not Stripe)</div>
<h1 id="product">${escapeHtml(session._productName)}</h1>
<p id="amount">${escapeHtml(formatMoney(session.amount_total, session.currency))}</p>
${closed ? `<p id="gone">This checkout session is ${escapeHtml(session.status)}.</p>` : `
<form method="post" action="/pay/${escapeHtml(session.id)}">
  <label>Card number <input id="cardNumber" name="cardNumber" autocomplete="off"></label>
  <button id="submitPay" type="submit">Pay ${escapeHtml(formatMoney(session.amount_total, session.currency))}</button>
</form>
${session.cancel_url ? `<p><a id="cancelLink" href="${escapeHtml(session.cancel_url)}">&larr; Back</a></p>` : ''}`}
<p id="error">${error ? escapeHtml(error) : ''}</p>
</body></html>`;
  }

  // ---- webhooks --------------------------------------------------------
  function buildEvent(type, object, { livemode = false, id } = {}) {
    return {
      id: id || randomId('evt'),
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode,
      type,
      data: { object },
    };
  }

  function emitEvent(type, object) {
    const event = buildEvent(type, object);
    state.events.set(event.id, event);
    if (state.holdWebhooks) {
      state.heldEvents.push(event);
      return event;
    }
    setTimeout(() => { deliver(event).catch(() => {}); }, webhookDelayMs);
    return event;
  }

  async function deliver(event, { signature = 'valid' } = {}) {
    const payload = JSON.stringify(event);
    let header;
    if (signature === 'valid') header = signPayload(payload, webhookSecret);
    else if (signature === 'tampered') header = signPayload(payload, `${webhookSecret}-wrong`);
    const record = { at: new Date().toISOString(), eventId: event.id, type: event.type, signature, status: null };
    state.deliveries.push(record);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(header ? { 'Stripe-Signature': header } : {}) },
        body: payload,
      });
      record.status = res.status;
    } catch (err) {
      record.status = `error: ${err.message}`;
    }
    return record;
  }

  // ---- test controls (/__control) --------------------------------------
  app.use('/__control', express.json());

  app.post('/__control/hold-webhooks', (req, res) => {
    state.holdWebhooks = !!req.body.hold;
    res.json({ hold: state.holdWebhooks });
  });

  app.post('/__control/release-webhooks', async (req, res) => {
    state.holdWebhooks = false;
    const held = state.heldEvents.splice(0);
    const results = [];
    for (const event of held) results.push(await deliver(event));
    res.json({ delivered: results });
  });

  app.post('/__control/fail-off-session', (req, res) => {
    const pm = state.paymentMethods.get(req.body.payment_method);
    if (!pm) return res.status(404).json({ error: 'no such payment method' });
    pm._failOffSession = !!req.body.fail;
    res.json({ payment_method: pm.id, fail: pm._failOffSession });
  });

  app.post('/__control/drop-next-responses', (req, res) => {
    state.dropNextResponses = Number(req.body.count || 1);
    res.json({ dropNextResponses: state.dropNextResponses });
  });

  // Creates a succeeded PaymentIntent (and, with with_customer, a Customer
  // + attached payment method) directly — for webhook scenarios whose
  // Checkout Session didn't come from the hosted page.
  app.post('/__control/payment-intent', (req, res) => {
    let customerId = null;
    let pmId = null;
    if (req.body.with_customer) {
      customerId = randomId('cus');
      state.customers.set(customerId, { id: customerId, object: 'customer', livemode: !!req.body.livemode });
      pmId = randomId('pm');
      state.paymentMethods.set(pmId, { id: pmId, object: 'payment_method', type: 'card', customer: customerId, livemode: !!req.body.livemode });
    }
    const pi = {
      id: randomId('pi'), object: 'payment_intent', amount: Number(req.body.amount || 50000), currency: 'usd',
      customer: customerId, payment_method: pmId, metadata: req.body.metadata || {}, livemode: !!req.body.livemode,
      status: req.body.status || 'succeeded', created: Math.floor(Date.now() / 1000),
    };
    state.paymentIntents.set(pi.id, pi);
    res.json(pi);
  });

  // Builds, signs (validly, tampered, or not at all) and delivers an
  // arbitrary event; returns the HTTP status the API answered with.
  app.post('/__control/send-event', async (req, res) => {
    const event = buildEvent(req.body.type, req.body.object, { livemode: !!req.body.livemode, id: req.body.id });
    state.events.set(event.id, event);
    res.json(await deliver(event, { signature: req.body.signature || 'valid' }));
  });

  app.post('/__control/replay-event', async (req, res) => {
    const event = state.events.get(req.body.id);
    if (!event) return res.status(404).json({ error: 'unknown event' });
    res.json(await deliver(event));
  });

  app.get('/__control/log', (req, res) => {
    res.json({ requests: state.requests, deliveries: state.deliveries });
  });

  app.get('/__control/state', (req, res) => {
    res.json({
      sessions: [...state.sessions.values()].map(publicSession),
      paymentIntents: [...state.paymentIntents.values()],
      customers: [...state.customers.values()],
      paymentMethods: [...state.paymentMethods.values()],
    });
  });

  return { app, state };
}

module.exports = { createStripeStandIn, signPayload };

if (require.main === module) {
  const port = Number(process.env.STRIPE_STAND_IN_PORT || 12111);
  const base = process.env.STRIPE_STAND_IN_PUBLIC_URL || `http://127.0.0.1:${port}`;
  const { app } = createStripeStandIn({
    publicBaseUrl: base,
    webhookUrl: process.env.STRIPE_STAND_IN_WEBHOOK_URL || 'http://127.0.0.1:3000/api/webhooks/stripe',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  app.listen(port, '127.0.0.1', () => console.log(`Stripe stand-in (test-only) on ${base}`));
}
