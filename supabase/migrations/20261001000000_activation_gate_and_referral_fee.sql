-- Wrapped in one explicit transaction, like the billing-schema migration:
-- the exemption check below must be able to abort *everything* — the new
-- billing_required column included — so a slug that doesn't match can
-- never leave the schema half-changed with every tenant (North Mountain
-- Structures and Good Steward Structures included) suddenly
-- billing_required = true and locked out at their next login.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. The API selects
-- tenants.billing_required on every staff request (src/db.js's
-- getCallerContext); code that reaches production before this column
-- exists fails every signed-in request, exempt tenants included.
begin;

-- New-dealer activation gate + 50.'s per-referral usage fee.
--
--   - tenants.billing_required: true (the default, for every tenant
--     created from here on) means the tenant's staff can't use the
--     dealer page or any staff API route until the tenant has paid the
--     one-time activation charge through Stripe Checkout, and every
--     referral it marks rewarded is charged 50.'s usage fee
--     (referral_fee_bps of the total payout, 30% by default). false means
--     none of that applies: no gate, no activation charge, no usage fee.
--   - Exactly three tenants are false, set below by slug and verified:
--     Good Steward Structures, North Mountain Structures, and 50. itself.
--     A CHECK constraint keeps them false permanently.
--   - billing_events gains a 'referral_fee' event type for the usage fee,
--     plus livemode on every new row, so a charge or activation recorded
--     against Stripe test mode can never be mistaken for real money later.
--   - authenticated loses table-wide UPDATE on tenants. A tenant admin's
--     own login token could otherwise rewrite billing_required,
--     activation_paid_at, or the fee rate on their own row directly
--     through Supabase's REST API and skip the gate entirely.

-- ---------------------------------------------------------------------------
-- tenants.billing_required
-- ---------------------------------------------------------------------------
-- A constant default fills every existing row with true when the column
-- is added (no table rewrite in Postgres 11+). The DO block below then
-- flips exactly the three exempt tenants to false — every other tenant
-- that already exists stays true and is gated at its next login unless
-- it has already paid activation (the block lists them by name).
alter table tenants
  add column billing_required boolean not null default true;

do $$
declare
  -- Matched by slug — tenants.slug is NOT NULL UNIQUE (init_schema.sql)
  -- and is the identifier every runbook in supabase/README.md already
  -- targets. Never by id or row order, which differ per database.
  exempt_slugs constant text[] := array[
    'good-steward-structures',    -- Good Steward Structures
    'north-mountain-structures',  -- North Mountain Structures
    'fifty-platform'              -- 50. itself
  ];
  missing text[];
  existing text;
  updated integer;
  r record;
begin
  select array_agg(s order by s) into missing
  from unnest(exempt_slugs) as s
  where not exists (select 1 from tenants t where t.slug = s);

  if missing is not null then
    select string_agg(format('%s (%s)', t.slug, t.name), ', ' order by t.created_at)
      into existing
    from tenants t;
    raise exception 'Billing exemption aborted — no tenant has slug %. Nothing in this migration was applied.',
      array_to_string(missing, ', ')
      using detail = format('Tenants in this database: %s', coalesce(existing, '(none)')),
            hint = 'Correct the slug in exempt_slugs (supabase/migrations/20261001000000_activation_gate_and_referral_fee.sql) to the tenant''s real slug, then re-run. Do not remove a slug to make this pass — that tenant would become billable.';
  end if;

  update tenants set billing_required = false where slug = any (exempt_slugs);
  get diagnostics updated = row_count;
  if updated <> 3 then
    raise exception 'Billing exemption aborted — expected exactly 3 tenants exempted, got %. Nothing in this migration was applied.', updated;
  end if;

  for r in select t.slug, t.name from tenants t where not t.billing_required order by t.slug loop
    raise notice 'billing_required = false (never charged, no activation gate): % — %', r.slug, r.name;
  end loop;

  for r in select t.slug, t.name, t.activation_paid_at from tenants t where t.billing_required order by t.created_at loop
    raise notice 'billing_required = true (activation gate applies%): % — %',
      case when r.activation_paid_at is null then ' at next login' else ', activation already recorded' end,
      r.slug, r.name;
  end loop;
end $$;

-- Permanent at the database level, not only by convention: nothing —
-- an UPDATE, a re-created tenant row, a bulk "turn billing on for every
-- tenant" — can make these three billable without first dropping this
-- constraint in a migration of its own. Added after the UPDATE above,
-- since the new column's default (true) would otherwise violate it on
-- the existing rows.
alter table tenants
  add constraint tenants_permanently_billing_exempt
    check (billing_required = false
           or slug not in ('good-steward-structures', 'north-mountain-structures', 'fifty-platform'));

comment on column tenants.billing_required is 'true (default for every new tenant): staff are blocked from the dealer page and every staff API route until the one-time activation charge succeeds (Stripe webhook-confirmed), and each referral marked rewarded is charged 50.''s usage fee (referral_fee_bps of the total payout). false: no activation gate, no activation charge, no usage fee — set only for Good Steward Structures, North Mountain Structures, and 50. itself, permanently (see tenants_permanently_billing_exempt).';
comment on constraint tenants_permanently_billing_exempt on tenants is 'Good Steward Structures, North Mountain Structures, and 50. itself are never billed — no activation charge, no referral usage fee. Changing that requires a migration that drops this constraint.';

-- ---------------------------------------------------------------------------
-- tenants — activation bookkeeping and the usage-fee rate
-- ---------------------------------------------------------------------------
alter table tenants
  add column activation_livemode boolean,
  add column activation_checkout_session_id text,
  add column referral_fee_bps integer not null default 3000
    check (referral_fee_bps > 0 and referral_fee_bps <= 10000);

comment on column tenants.activation_livemode is 'Stripe''s own livemode flag on the Checkout Session whose webhook set activation_paid_at: true = real money, false = Stripe test mode. Null for any activation recorded before this column existed (all of which were test mode). While the API runs on a live Stripe key, only true counts as activated, so a test-mode or stand-in activation can never unlock a real tenant. A later live payment supersedes a non-live one.';
comment on column tenants.activation_checkout_session_id is 'The most recent activation Checkout Session created for this tenant. POST /api/billing/checkout-session reuses it while it is still open, and reports "payment processing" instead of creating a second session once it has been completed — so signing in again, or a second admin signing in, never opens a second $500 checkout. Written only by the API''s service-role connection.';
comment on column tenants.referral_fee_bps is '50.''s usage fee on a rewarded referral, in basis points of the total payout (both gift cards: reward_amount_cents * 2). 3000 = 30%, so a $100 payout is charged $30. Charged to the tenant''s saved Stripe payment method when a referral is marked rewarded, only while billing_required is true; snapshotted onto each billing_events row as fee_rate_bps. The tenant funds the gift cards itself — this is the fee alone.';

-- ---------------------------------------------------------------------------
-- billing_events — the usage fee, and livemode on every new row
-- ---------------------------------------------------------------------------
-- Postgres has no ALTER ... ADD VALUE for an inline CHECK, so this drops
-- and recreates the constraint under its default name — the same dance
-- the billing-schema migration did for referrals.status.
alter table billing_events drop constraint billing_events_event_type_check;
alter table billing_events
  add constraint billing_events_event_type_check
    check (event_type in ('activation_charge', 'referral_charge', 'referral_fee', 'payment_failed', 'dispute_created'));

alter table billing_events
  add column fee_rate_bps integer,
  add column livemode boolean;

alter table billing_events
  add constraint billing_events_referral_fee_shape
    check (event_type <> 'referral_fee'
           or (referral_id is not null and fee_rate_bps is not null and reward_amount_cents is not null));

-- At most one usage-fee attempt per referral that is in flight or has
-- succeeded — enforced by the database, not only by the API's own
-- checks. 'failed' attempts are deliberately outside it, so a declined
-- card can be retried (each retry is its own row with its own Stripe
-- Idempotency-Key). 'pending' is deliberately inside it (unlike
-- billing_events_one_referral_charge_idx): a pending row is an attempt
-- whose outcome isn't known yet, and a second attempt on top of it is
-- exactly how a card gets charged twice.
create unique index billing_events_one_referral_fee_idx
  on billing_events (referral_id)
  where event_type = 'referral_fee' and status in ('pending', 'succeeded');

comment on column billing_events.event_type is '''activation_charge'' (once per tenant, Checkout webhook), ''referral_charge'' (the Stage 4 platform-funded worker, once per referral), ''referral_fee'' (50.''s usage fee on a billing_required tenant''s rewarded referral — the tenant funds the gift cards itself), ''payment_failed'' and ''dispute_created'' (webhooks, inserted fresh rather than mutating the original charge''s row).';
comment on column billing_events.reward_amount_cents is 'Snapshot of tenants.reward_amount_cents (per card) at charge time. Set for event_type referral_charge and referral_fee; null otherwise.';
comment on column billing_events.fee_rate_bps is 'Snapshot of tenants.referral_fee_bps at charge time — only for event_type = referral_fee, where amount_cents = round(reward_amount_cents * 2 * fee_rate_bps / 10000).';
comment on column billing_events.livemode is 'Stripe''s livemode flag on the object this row records (false = test mode). Null on rows written before this column existed, and on a referral_fee attempt that never got a response from Stripe.';
comment on index billing_events_one_referral_fee_idx is 'At most one in-flight-or-succeeded usage fee per referral. Failed attempts are excluded so a declined card can be retried.';

-- ---------------------------------------------------------------------------
-- referrals — 'rewarded' requires a collected usage fee
-- ---------------------------------------------------------------------------
-- The API charges the usage fee before it marks a billing-required
-- tenant's referral rewarded (routes/referrals.js). This holds the
-- database to the same line on every other path a signed-in staff member
-- has: referrals_update_admin lets an admin update their own tenant's
-- referrals directly through Supabase's REST API with the dealer page's
-- login token, which would otherwise mark a referral paid without the fee
-- ever being charged. Written to fail closed — the tenant must be
-- positively exempt, or a succeeded 'referral_fee' row must exist; a row
-- RLS somehow hid would refuse the update, not allow it. Superuser
-- connections (the API's own service role, i.e. the Stage 4 worker;
-- migrations; the SQL editor) aren't subject to it.
create function referrals_require_usage_fee() returns trigger
language plpgsql
as $$
begin
  if new.status = 'rewarded'
     and old.status is distinct from 'rewarded'
     and current_setting('is_superuser') <> 'on'
     and not exists (select 1 from tenants t where t.id = new.tenant_id and t.billing_required = false)
     and not exists (
       select 1 from billing_events be
       where be.referral_id = new.id
         and be.event_type = 'referral_fee'
         and be.status = 'succeeded'
     )
  then
    raise exception 'Referral % can''t be marked rewarded until 50.''s usage fee for it has been collected.', new.id;
  end if;
  return new;
end;
$$;

create trigger referrals_require_usage_fee_trigger
  before update of status on referrals
  for each row
  execute function referrals_require_usage_fee();

comment on function referrals_require_usage_fee() is 'Refuses a non-superuser update that moves a billing-required tenant''s referral into ''rewarded'' unless a succeeded referral_fee billing_events row exists for it — the database backstop for the API''s charge-before-rewarded rule (routes/referrals.js).';

-- ---------------------------------------------------------------------------
-- tenants — column-level UPDATE for authenticated
-- ---------------------------------------------------------------------------
-- tenants_update_own_admin (rls_policies.sql) lets an admin update their
-- own tenant row. With table-wide UPDATE, that included every billing
-- column — and Supabase's REST API (PostgREST) accepts the same login
-- token the dealer page uses, so an admin could PATCH their own row to
-- billing_required = false, set activation_paid_at, or lower
-- activation_fee_cents / referral_fee_bps / reward_amount_cents, without
-- ever touching this API. Only the columns the API itself writes as the
-- signed-in admin stay updatable: routes/billing.js's
-- monthly_spend_cap_cents and routes/tenantSettings.js's Tremendous
-- credentials. Every other column is writable only by the service role
-- (webhooks, the worker, the API's billing writes) and the postgres role.
revoke update on tenants from authenticated;
grant update (monthly_spend_cap_cents,
              tremendous_api_key_encrypted,
              tremendous_funding_source_id,
              tremendous_campaign_id,
              tremendous_connected_at)
  on tenants to authenticated;

commit;
