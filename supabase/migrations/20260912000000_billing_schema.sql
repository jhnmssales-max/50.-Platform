-- Wrapped in an explicit transaction: several statements below depend on
-- ones before them (a CHECK constraint referencing a column added two
-- statements earlier, an index on that same column), so a mid-migration
-- failure must roll back everything, not leave the schema half-changed.
begin;

-- Stage 1 of Stripe billing: schema only. No API routes, no Stripe calls,
-- no webhook handler yet — those are Stages 2-4. This migration just adds
-- the columns and tables everything after it will read and write.
--
-- Pricing is per-tenant and variable (not a fixed Stripe catalog price):
-- each tenant sets its own activation_fee_cents, reward_amount_cents
-- (already existed — see below), platform_fee_cents, and
-- monthly_spend_cap_cents. The per-referral charge is always
-- reward_amount_cents * 2 (one $X reward for the referrer, one for the
-- new customer) + platform_fee_cents (never itemized to the dealer as a
-- separate line — see api/README.md once Stage 4 lands).
--
-- tenants.reward_amount_cents already exists (init_schema.sql, default
-- 5000) — it's reused here as-is, not re-added, since it's already
-- exactly "per person, so $50 = 5000" as specified.

-- ---------------------------------------------------------------------------
-- tenants — billing identity, per-tenant pricing, and spend guardrails.
-- ---------------------------------------------------------------------------
alter table tenants
  add column stripe_customer_id        text,
  add column stripe_payment_method_id  text,
  add column billing_status            text not null default 'pending'
                                          check (billing_status in ('active', 'suspended', 'pending')),
  add column activation_paid_at        timestamptz,
  add column activation_fee_cents      integer not null default 50000
                                          check (activation_fee_cents >= 0),
  add column platform_fee_cents        integer not null default 9900
                                          check (platform_fee_cents >= 3900),
  add column monthly_spend_cap_cents   integer not null default 400000
                                          check (monthly_spend_cap_cents >= 0),
  add column payment_method_type       text not null default 'card'
                                          check (payment_method_type in ('card', 'us_bank_account'));

-- The per-referral charge, derived once here rather than recomputed by
-- hand in every place that needs it (the payment-method guard below, and
-- Stage 4's worker). Still a *mirror* of that computation, not a
-- replacement for it — Stage 4 computes the actual PaymentIntent amount
-- from live tenant config at charge time, same formula, so this and that
-- can never drift apart.
alter table tenants
  add column per_referral_charge_cents integer
    generated always as (reward_amount_cents * 2 + platform_fee_cents) stored;

-- A card can't be charged for amounts Stripe (and most issuing banks)
-- start treating as high-risk / subject to extra authentication — require
-- ACH (us_bank_account) once a tenant's own per-referral total crosses
-- $500. This is the schema-level backstop; Stage 2's onboarding endpoint
-- is expected to check the same thing before ever creating a Checkout
-- session, so a dealer sees a clear error instead of a raw constraint
-- violation.
alter table tenants
  add constraint tenants_card_requires_low_charge
    check (payment_method_type = 'us_bank_account' or per_referral_charge_cents <= 50000);

create index tenants_billing_status_idx on tenants (billing_status);

comment on column tenants.stripe_customer_id is 'This tenant''s Stripe Customer id. Null until the activation checkout session completes (Stage 2).';
comment on column tenants.stripe_payment_method_id is 'The payment method saved off the activation charge (setup_future_usage: off_session), reused for every off-session per-referral charge in Stage 4. Not a secret — Stripe''s own id for a saved card/bank account, never the underlying card/account number.';
comment on column tenants.billing_status is '''pending'' until the activation charge clears (Stage 2''s webhook flips it to ''active''); ''suspended'' on a failed payment or a dispute (Stage 3). Stage 4''s worker only issues rewards for an ''active'' tenant.';
comment on column tenants.activation_paid_at is 'Set once, by Stage 2''s checkout.session.completed webhook. Null means the one-time activation charge has never succeeded.';
comment on column tenants.activation_fee_cents is 'What this tenant is charged once, at onboarding, to activate their account. Per-tenant and variable — not a Stripe catalog price. Default 50000 ($500) matches the platform''s original flat pricing; any tenant can be configured differently.';
comment on column tenants.platform_fee_cents is 'This tenant''s per-successful-referral platform fee, on top of funding both gift cards. Never itemized to the dealer as its own line — see the reward-issuance flow in api/README.md once Stage 4 lands. Constrained to >= 3900 ($39) as a pricing floor. Default 9900 ($99) matches the platform''s original flat pricing.';
comment on column tenants.monthly_spend_cap_cents is 'A dollar guardrail on this tenant''s total referral-reward spend per calendar month, not a count of referrals (pricing is per-tenant and variable, so a fixed referral count wouldn''t mean the same dollar exposure for every tenant). Stage 4''s worker checks this before issuing each reward. Default 400000 ($4,000) is roughly 20 referrals'' worth at the original flat $199 charge — a starting point per tenant, not a platform-wide rule.';
comment on column tenants.payment_method_type is 'Which kind of saved payment method this tenant''s off-session charges use. ''card'' is only allowed while per_referral_charge_cents stays at or under $500 (see tenants_card_requires_low_charge) — above that, ''us_bank_account'' (ACH) is required.';
comment on column tenants.per_referral_charge_cents is 'Generated, not stored input: reward_amount_cents * 2 (referrer + new customer) + platform_fee_cents. Recalculates automatically if either input changes. Mirrors the amount Stage 4 actually charges — see billing_events.reward_amount_cents/platform_fee_cents for why a charge''s own record snapshots these instead of trusting this live value after the fact.';

-- ---------------------------------------------------------------------------
-- billing_events — append-only ledger of every Stripe-facing billing
-- occurrence: the one-time activation charge, each per-referral reward
-- charge, a failed payment, and a dispute. Never mutated to rewrite
-- history — the one exception is a referral_charge row's own status
-- moving from 'succeeded' to 'needs_refund' if the gift card call that
-- follows a successful charge then fails (Stage 4), which is a correction
-- to that same charge's outcome, not a different event.
-- ---------------------------------------------------------------------------
create table billing_events (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references tenants(id),
  referral_id                 uuid references referrals(id),
  event_type                  text not null
                                check (event_type in ('activation_charge', 'referral_charge', 'payment_failed', 'dispute_created')),
  amount_cents                integer not null,
  -- Snapshot of the tenant's own pricing config at the moment of charge —
  -- deliberately duplicated from tenants, not joined at read time, so a
  -- later pricing change on the tenant (or even the platform-wide
  -- defaults above) can never alter what a historical billing_events row
  -- appears to have charged and why. Only meaningful for event_type =
  -- 'referral_charge' (the only event with a reward/fee split at all);
  -- null for every other event_type.
  reward_amount_cents         integer,
  platform_fee_cents          integer,
  stripe_payment_intent_id    text,
  status                      text not null
                                check (status in ('pending', 'succeeded', 'failed', 'needs_refund', 'disputed')),
  error_detail                text,
  created_at                  timestamptz not null default now()
);

create index billing_events_tenant_id_idx on billing_events (tenant_id);
create index billing_events_referral_id_idx on billing_events (referral_id);
create index billing_events_stripe_payment_intent_id_idx on billing_events (stripe_payment_intent_id);

-- At most one non-failed referral_charge per referral, enforced by the
-- database itself rather than trusted to the worker's own row-selection
-- logic (see referrals.reward_issued_at and the partial index below it) —
-- the same "the database is the final backstop against a double-charge"
-- pattern gift_card_transactions.idempotency_key already uses.
create unique index billing_events_one_referral_charge_idx
  on billing_events (referral_id)
  where event_type = 'referral_charge' and status in ('succeeded', 'needs_refund');

comment on table billing_events is 'Append-only ledger of every Stripe-facing billing occurrence for a tenant: the one-time activation charge, each per-referral reward charge, a failed payment, and a dispute. referral_id is null for anything not tied to a specific referral (activation, or a payment_failed/dispute event on the activation charge itself).';
comment on column billing_events.event_type is '''activation_charge'' (Stage 2, once per tenant), ''referral_charge'' (Stage 4, once per referral — see the unique index below), ''payment_failed'' and ''dispute_created'' (Stage 3''s webhook, inserted fresh rather than mutating the original charge''s row, since a failure or dispute is its own occurrence in time).';
comment on column billing_events.status is '''succeeded''/''failed'' for a charge''s own outcome; ''needs_refund'' is a referral_charge whose gift card issuance failed after the charge already succeeded (Stage 4) — the charge is not retried, a human resolves it; ''disputed'' for a dispute_created event; ''pending'' is available for a future stage that needs to record a charge attempt before its outcome is known (nothing writes it yet).';
comment on column billing_events.reward_amount_cents is 'Snapshot of tenants.reward_amount_cents at charge time. Null except for event_type = referral_charge.';
comment on column billing_events.platform_fee_cents is 'Snapshot of tenants.platform_fee_cents at charge time. Null except for event_type = referral_charge.';

-- ---------------------------------------------------------------------------
-- billing_events RLS — every staff member of a tenant can see that
-- tenant's own billing history; nobody gets insert/update/delete through
-- the authenticated role at all. Unlike every other table in this schema,
-- there is no admin-authenticated write path here to grant, because
-- there's no staff session to require one of: every write comes from a
-- Stripe webhook or the reward-issuance background worker (Stages 2-4),
-- neither of which has a logged-in user to impersonate. Both are expected
-- to run under Supabase's actual service_role connection, which bypasses
-- RLS entirely — "service role full access" is a literal statement about
-- which Postgres role does the writing, not aspirational language the
-- way it was for gift_card_transactions/audit_log before those got
-- retrofitted to admin-authenticated writes instead.
-- ---------------------------------------------------------------------------
alter table billing_events enable row level security;

grant select on billing_events to authenticated;

create policy billing_events_select_same_tenant on billing_events
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- referrals — the 7-day hold and reward-issuance tracking.
-- ---------------------------------------------------------------------------
alter table referrals
  add column closed_at         timestamptz,
  add column reward_issued_at  timestamptz,
  add column billing_event_id  uuid references billing_events(id);

-- 'closed' is its own dedicated status, set only via POST
-- /api/referrals/:id/close (never a side effect of the general-purpose
-- PATCH /api/referrals/:id/status, which explicitly refuses to move a
-- referral into or out of 'closed' — see api/src/routes/referrals.js) —
-- so status and closed_at can never disagree about whether a referral is
-- closed. Postgres has no ALTER ... ADD VALUE for an inline CHECK the
-- way it does for a native enum type, so this drops and recreates the
-- constraint under its default name.
alter table referrals drop constraint referrals_status_check;
alter table referrals
  add constraint referrals_status_check
    check (status in ('new', 'contacted', 'ordered', 'closed', 'rewarded', 'declined'));

-- Derived from closed_at by trigger rather than set by application code,
-- so the 7-day hold can never be computed wrong (or forgotten) by
-- whatever code path sets closed_at — and if closed_at is ever
-- corrected, eligibility moves with it automatically. Not a GENERATED
-- column: Postgres requires a generated column's expression to be
-- IMMUTABLE, and timestamptz + interval isn't (day-interval arithmetic
-- on a timestamptz depends on the session's TimeZone setting across DST
-- boundaries) — confirmed live, this fails with "generation expression
-- is not immutable" if attempted. A BEFORE trigger has no such
-- restriction and gives the identical guarantee: any client-supplied
-- value is silently overwritten by the derived one, on every insert and
-- on every update that touches closed_at.
alter table referrals
  add column reward_eligible_at timestamptz;

create or replace function referrals_set_reward_eligible_at() returns trigger
language plpgsql
as $$
begin
  new.reward_eligible_at := new.closed_at + interval '7 days';
  return new;
end;
$$;

-- "of closed_at, reward_eligible_at" (not just closed_at) so a direct
-- write to reward_eligible_at itself — bypassing closed_at entirely — is
-- also caught and overwritten by the trigger, not silently accepted.
-- Confirmed live: with only "of closed_at" here, an UPDATE that touched
-- reward_eligible_at alone went through unguarded.
create trigger referrals_reward_eligible_at_trigger
  before insert or update of closed_at, reward_eligible_at on referrals
  for each row
  execute function referrals_set_reward_eligible_at();

comment on function referrals_set_reward_eligible_at() is 'Maintains referrals.reward_eligible_at as closed_at + 7 days. Exists as a trigger, not a GENERATED column, because timestamptz + interval is not IMMUTABLE (session TimeZone-dependent across DST) — see the migration comment above this trigger''s creation.';

alter table referrals
  add constraint referrals_no_early_reward
    check (reward_issued_at is null or (reward_eligible_at is not null and reward_issued_at >= reward_eligible_at));

alter table referrals
  add constraint referrals_billing_event_id_key unique (billing_event_id);

-- Serves Stage 4's worker query directly: "closed_at is set,
-- reward_eligible_at <= now, reward_issued_at is null."
create index referrals_reward_eligible_idx on referrals (reward_eligible_at)
  where closed_at is not null and reward_issued_at is null;

comment on column referrals.closed_at is 'When the underlying job/order was marked closed. Starts the 7-day hold. Null means not yet closed — not yet eligible for a reward at all, regardless of status. How this gets set (which endpoint, whether it''s tied to referrals.status) is a Stage 2+ question, deliberately not resolved by this schema-only migration.';
comment on column referrals.reward_eligible_at is 'Maintained by the referrals_reward_eligible_at_trigger trigger: closed_at + 7 days. Null exactly when closed_at is null. Any value written directly to this column is silently overwritten by the trigger.';
comment on column referrals.reward_issued_at is 'Set by Stage 4''s worker as its last step, only after a successful charge and a successful gift-card-provider call. Null means no reward has gone out yet — including the needs_refund case, where the charge succeeded but issuance did not, so nothing was actually issued.';
comment on column referrals.billing_event_id is 'The one billing_events row (event_type = referral_charge) representing this referral''s charge, successful or needs-refund. Unique — a referral can never point at more than one such row (see also billing_events'' own partial unique index enforcing the reverse direction).';

commit;
