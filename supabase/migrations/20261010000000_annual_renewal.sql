-- Wrapped in one explicit transaction, like the activation-gate migration:
-- either the whole annual-renewal schema lands or none of it does.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. The Stripe webhook
-- (routes/webhooks.js) writes tenants.renewal_due_at when a tenant activates,
-- and the renewal worker (workers/annualRenewal.js) selects it; code that
-- reaches production before these columns exist fails every activation.
begin;

-- Annual renewal fee: the $500 activation covers the first 12 months, then
-- tenants.annual_fee_cents ($100 by default) is charged to the card saved at
-- activation, once a year, starting 12 months after the activation payment.
--
--   - tenants.annual_fee_cents: the yearly fee, per tenant so one dealer's
--     can be changed (or set to 0 to waive it) without touching the others.
--   - tenants.renewal_due_at: when the next annual fee is due. Set by the
--     Stripe webhook the moment a live activation payment is confirmed
--     (activation time + 12 months) and advanced by 12 months each time a
--     renewal succeeds. Null = nothing to charge: billing-exempt tenants,
--     tenants that haven't activated, and tenants only ever "activated" in
--     Stripe test mode.
--   - tenants.renewal_notice_sent_for: the renewal_due_at value a "your
--     annual fee is coming up" email has already gone out for, so the
--     hourly worker sends it once per renewal, not once per run.
--   - billing_events gains an 'annual_renewal' event type. renews_from is
--     the renewal_due_at the attempt was for — the "period" of that charge.

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
alter table tenants
  add column annual_fee_cents integer not null default 10000
    check (annual_fee_cents >= 0),
  add column renewal_due_at timestamptz,
  add column renewal_notice_sent_for timestamptz;

-- The three billing-exempt tenants are never charged anything, annual fee
-- included. billing_required is already permanently false for them
-- (tenants_permanently_billing_exempt); this keeps a renewal date from ever
-- being attached to a tenant that can't be billed.
alter table tenants
  add constraint tenants_exempt_has_no_renewal
    check (billing_required = true or renewal_due_at is null);

comment on column tenants.annual_fee_cents is 'The yearly fee 50. charges a billing-required tenant to the card saved at activation, starting 12 months after its activation payment (the one-time activation fee covers the first year). 10000 = $100. 0 waives the renewal: the worker just moves renewal_due_at forward a year without charging anything. Written only by the service role / SQL editor.';
comment on column tenants.renewal_due_at is 'When the next annual fee is due. Set to activation time + 12 months by the Stripe webhook when a live activation payment is confirmed, and advanced 12 months each time a renewal succeeds (workers/annualRenewal.js). Null: not billable for a renewal (billing-exempt, not yet activated, or activated only in Stripe test mode). To re-arm a tenant whose renewal attempts ran out, set this to now() — it starts a fresh period with fresh attempts.';
comment on column tenants.renewal_notice_sent_for is 'The renewal_due_at value the "annual fee coming up" email was already sent for. The worker sends that email once per renewal_due_at value.';

-- Existing tenants that have already paid the activation for real: their
-- first year runs from that payment. A test-mode activation isn't money, so
-- those (and unactivated tenants) stay null and get their date when they
-- pay for real.
update tenants
set renewal_due_at = activation_paid_at + interval '12 months'
where billing_required
  and activation_paid_at is not null
  and activation_livemode is true;

-- ---------------------------------------------------------------------------
-- billing_events
-- ---------------------------------------------------------------------------
alter table billing_events drop constraint billing_events_event_type_check;
alter table billing_events
  add constraint billing_events_event_type_check
    check (event_type in ('activation_charge', 'referral_charge', 'referral_fee', 'annual_renewal', 'payment_failed', 'dispute_created'));

alter table billing_events
  add column renews_from timestamptz;

alter table billing_events
  add constraint billing_events_annual_renewal_shape
    check (event_type <> 'annual_renewal' or renews_from is not null);

-- At most one annual-fee attempt per tenant per renewal period that is in
-- flight or has succeeded — enforced by the database, not only by the
-- worker's own checks. Same reasoning as billing_events_one_referral_fee_idx:
-- 'failed' attempts sit outside it so a declined card can be retried (each
-- retry its own row with its own Stripe Idempotency-Key), 'pending' sits
-- inside it because a pending row is an attempt whose outcome isn't known
-- yet and a second attempt on top of it is how a card gets charged twice.
create unique index billing_events_one_annual_renewal_idx
  on billing_events (tenant_id, renews_from)
  where event_type = 'annual_renewal' and status in ('pending', 'succeeded');

comment on column billing_events.event_type is '''activation_charge'' (once per tenant, Checkout webhook), ''referral_charge'' (the Stage 4 platform-funded worker, once per referral), ''referral_fee'' (50.''s usage fee on a billing_required tenant''s rewarded referral), ''annual_renewal'' (the yearly fee, charged by workers/annualRenewal.js; renews_from says which renewal period), ''payment_failed'' and ''dispute_created'' (webhooks, inserted fresh rather than mutating the original charge''s row).';
comment on column billing_events.renews_from is 'For event_type = annual_renewal: the tenants.renewal_due_at value this attempt was charging for. Null for every other event type.';
comment on index billing_events_one_annual_renewal_idx is 'At most one in-flight-or-succeeded annual renewal charge per tenant per renewal period. Failed attempts are excluded so a declined card can be retried.';

commit;
