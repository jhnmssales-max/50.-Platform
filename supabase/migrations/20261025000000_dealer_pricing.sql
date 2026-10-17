-- Per-dealer pricing, and who actually sends the gift cards.
--
-- WHAT CHANGES, AND WHY
--
-- The usage fee was a percentage (referral_fee_bps, 30%) of the total payout
-- -- both cards -- so a $50/$50 program was charged $30. That breaks for the
-- dealers who buy and send their own gift cards: 50. never fronts those cards,
-- so there is nothing to take a percentage OF. Set their reward to $0 to
-- reflect that 50. isn't paying for cards and the fee collapses to 30% of
-- nothing. The fee is now a flat amount per rewarded referral
-- (referral_fee_cents), which is the same money for today's dealers and
-- survives a dealer whose cards 50. never touches.
--
-- referral_fee_bps is deliberately LEFT IN PLACE. billing_events.fee_rate_bps
-- records the rate each historical charge was computed at, and dropping the
-- column it came from would orphan that history. Nothing new reads it.
--
-- WHY A NEW COLUMN AND NOT tenants.platform_fee_cents
--
-- platform_fee_cents already looks like this: a flat per-referral fee,
-- defaulting to $99. It belongs to the OTHER billing path -- the Stage 4
-- reward-issuance worker, which charges per_referral_charge_cents (a
-- generated column: reward_amount_cents * 2 + platform_fee_cents) and buys
-- the gift cards itself. That worker refuses to run unless
-- GIFT_CARD_PROVIDER names a real provider, and it is 'stub' today, so it
-- charges nobody; every live charge goes through routes/referrals.js ->
-- lib/referralFee.js instead.
--
-- Reusing platform_fee_cents would mean editing an input to a stored
-- generated column that a dormant worker still reads, so the day a gift-card
-- provider is finally connected that worker would wake up charging amounts
-- someone set for a different purpose. It also carries a >= $39 floor, and
-- these fees need to go lower than that. Hence a separate column for the
-- path that actually runs.
--
-- NOBODY'S BILL CHANGES. referral_fee_cents is backfilled from each tenant's
-- own existing rate and reward, so every dealer already running keeps paying
-- exactly what they paid yesterday. The default for a tenant with no reward
-- set is $30, which is 30% of the standard $50/$50 program.

alter table tenants
  -- The flat fee charged when a referral is marked rewarded. 0 is allowed:
  -- an in-house or free dealer is a real case, and billing_exempt already
  -- skips the charge entirely anyway.
  add column referral_fee_cents integer not null default 3000
    check (referral_fee_cents >= 0),

  -- Who puts the gift cards in the customer's hands.
  --   'dealer'   -- 50. emails the dealer, the dealer sends the cards
  --               (or mails physical ones) whenever it suits them.
  --   'platform' -- 50. emails the cards straight to the customer and the
  --               friend when the dealer marks the referral paid.
  -- Defaults to 'dealer' because that is how every tenant works today:
  -- Good Steward's cards are bought and sent by hand.
  add column reward_fulfillment text not null default 'dealer'
    check (reward_fulfillment in ('dealer', 'platform')),

  -- Whether the dealer's card is also charged the face value of the gift
  -- cards on top of the fee. Separate from reward_fulfillment on purpose:
  -- who sends a card and who pays for it are two different questions, and
  -- Joseph sets them per dealer. False everywhere today -- no tenant is
  -- currently charged for cards 50. did not buy.
  add column charge_card_cost boolean not null default false;

-- Each tenant's own historical rate against its own reward, so the flat
-- amount lands on exactly the number its percentage produced. Both inputs
-- are NOT NULL, so this covers every tenant -- no row is left on the bare
-- default and no row is silently backfilled to zero.
update tenants
   set referral_fee_cents = round((reward_amount_cents * 2 * referral_fee_bps)::numeric / 10000)::integer;

comment on column tenants.referral_fee_cents is
  'Flat fee charged to this dealer each time a referral is marked rewarded. Replaced the referral_fee_bps percentage, which could not bill a dealer whose gift cards 50. never buys. See api/src/lib/referralFee.js.';
comment on column tenants.reward_fulfillment is
  '''platform'' = 50. emails the gift cards to the customer and friend; ''dealer'' = 50. emails the dealer and they send them. Does not by itself decide who PAYS for the cards -- that is charge_card_cost.';
comment on column tenants.charge_card_cost is
  'When true, this dealer is charged the gift cards'' face value on top of referral_fee_cents. For dealers whose cards 50. buys.';
comment on column tenants.referral_fee_bps is
  'HISTORICAL ONLY since 20261025000000_dealer_pricing. billing_events.fee_rate_bps records the rate past charges used; nothing new reads this. New charges use referral_fee_cents.';


-- ---------------------------------------------------------------------------
-- billing_events has to be able to explain a flat-fee charge.
--
-- billing_events_referral_fee_shape required fee_rate_bps on every
-- 'referral_fee' row: a charge had to record the percentage it was computed
-- at, which was the only way to explain the amount. There is no percentage
-- any more, so the thing that explains the amount is the fee itself -- and
-- when the dealer is also charged for the cards, amount_cents is fee plus
-- cards and the split has to be recorded or a receipt cannot break it down.
--
-- fee_cents is a SNAPSHOT, like reward_amount_cents and fee_rate_bps beside
-- it. Joseph can change a dealer's fee whenever he likes; a charge already
-- made must keep the number it was actually made at, not follow the tenant
-- row afterwards.
alter table billing_events
  add column fee_cents integer check (fee_cents >= 0);

alter table billing_events
  drop constraint billing_events_referral_fee_shape;

alter table billing_events
  add constraint billing_events_referral_fee_shape
    check (event_type <> 'referral_fee'
           or (referral_id is not null
               and reward_amount_cents is not null
               -- Either explanation is acceptable: the old rows carry the
               -- rate they were computed at, the new ones carry the flat fee.
               -- Neither is not.
               and (fee_rate_bps is not null or fee_cents is not null)));

comment on column billing_events.fee_cents is
  'Snapshot of 50.''s flat fee at charge time (tenants.referral_fee_cents). amount_cents minus this is the gift cards'' face value, when the dealer was charged for cards 50. bought. Null on rows charged before the flat fee, which carry fee_rate_bps instead.';


-- ---------------------------------------------------------------------------
-- approve_lead_build carries the prices through.
--
-- The settings have to be applied in the SAME transaction that creates the
-- tenant. The API's own connection runs as the signed-in admin, where RLS
-- hides every tenant but their own, so a follow-up UPDATE from up there
-- would either be refused or need the service role on a second connection --
-- and then a dealer could exist for a moment at standard prices.
-- This function is already security definer, so the prices land with the
-- insert or not at all.

create or replace function approve_lead_build(
  p_lead_id uuid,
  p_slug text,
  p_name text,
  p_brand jsonb,
  p_reward_amount_cents integer default null,
  -- Joseph sets each dealer's prices himself on the build screen. Null on any
  -- of these means "leave it at the column default", so a build that sends
  -- nothing behaves exactly as it did before they existed.
  p_activation_fee_cents integer default null,
  p_annual_fee_cents integer default null,
  p_referral_fee_cents integer default null,
  p_reward_fulfillment text default null,
  p_charge_card_cost boolean default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead rep_leads%rowtype;
  v_tenant_id uuid;
  v_slug text;
  v_n int;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can build a dealer' using errcode = '42501';
  end if;

  select * into v_lead from rep_leads where id = p_lead_id for update;
  if not found then
    raise exception 'No such lead' using errcode = 'P0002';
  end if;
  if v_lead.status <> 'won' then
    raise exception 'That lead has not been won yet' using errcode = '22023';
  end if;
  if v_lead.build_status = 'built' then
    raise exception 'That lead already has a 50. account' using errcode = '22023';
  end if;
  if coalesce(btrim(p_slug), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'A dealer needs a name and a slug' using errcode = '22023';
  end if;

  -- Make the address unique HERE rather than in the API, because the API runs
  -- as the signed-in user and RLS hides every tenant but their own: a check
  -- for "is this slug taken" run up there would answer no for every dealer
  -- that exists, and then the insert would fail on the unique index. Two
  -- businesses with the same name is not far-fetched, so the second one gets
  -- a -2 and the third a -3.
  v_slug := btrim(p_slug);
  if exists (select 1 from tenants where slug = v_slug) then
    for v_n in 2..60 loop
      if not exists (select 1 from tenants where slug = v_slug || '-' || v_n) then
        v_slug := v_slug || '-' || v_n;
        exit;
      end if;
      if v_n = 60 then
        raise exception 'Too many dealers already use that name — give this one a slightly different name' using errcode = '22023';
      end if;
    end loop;
  end if;

  -- billing_required defaults to true, which is what gates them into paying
  -- the $500 at their first sign-in. Never set it here: the three exempt
  -- tenants are fixed in the schema and a built dealer is never one of them.
  if p_reward_fulfillment is not null and p_reward_fulfillment not in ('dealer', 'platform') then
    raise exception 'reward_fulfillment must be dealer or platform' using errcode = '22023';
  end if;

  insert into tenants (
    slug, name, branding, reward_amount_cents,
    activation_fee_cents, annual_fee_cents, referral_fee_cents,
    reward_fulfillment, charge_card_cost
  )
  values (
    v_slug,
    btrim(p_name),
    coalesce(p_brand, '{}'::jsonb),
    coalesce(p_reward_amount_cents, 5000),
    -- Each falls back to the column default, so the prices a dealer gets
    -- when Joseph changes nothing are the standard ones.
    coalesce(p_activation_fee_cents, 50000),
    coalesce(p_annual_fee_cents, 10000),
    coalesce(p_referral_fee_cents, 3000),
    coalesce(p_reward_fulfillment, 'dealer'),
    coalesce(p_charge_card_cost, false)
  )
  returning id into v_tenant_id;

  update rep_leads
     set tenant_id = v_tenant_id,
         build_status = 'built',
         built_at = now(),
         approved_by = auth.uid(),
         brand = coalesce(p_brand, brand),
         reward_amount_cents = p_reward_amount_cents
   where id = p_lead_id;

  -- The rep who closed it goes on the dealer, which is what earns them the
  -- $50 once the activation clears. assign_rep() is not called here because
  -- it refuses anyone who is not staff and this already ran its own admin
  -- check; the insert is the same one it would make.
  if v_lead.closed_by_rep_id is not null or v_lead.onboarded_by_rep_id is not null then
    insert into rep_assignments (tenant_id, closer_rep_id, onboarder_rep_id, effective_from)
    values (v_tenant_id, v_lead.closed_by_rep_id, v_lead.onboarded_by_rep_id, now());
  end if;

  return v_tenant_id;
end;
$$;

-- The caller needs the address that was actually used, which may not be the
-- one it asked for. Kept as a separate lookup rather than a second return
-- value so the function's signature stays one id.

-- The 5-argument version is replaced, not left beside this one: two
-- overloads of the same name differing only by trailing defaults is how a
-- caller ends up silently hitting the old one and getting standard prices
-- for a dealer Joseph priced himself.
drop function if exists approve_lead_build(uuid, text, text, jsonb, integer);

revoke all on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text, boolean) from public, anon;
grant execute on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text, boolean) to authenticated;
comment on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text, boolean) is 'Admin only. Turns a won lead into a real 50. dealer: creates the tenant with its branding, gift card and the prices Joseph set on the build screen, puts the closing rep on it, and marks the lead built — all in one transaction. Any price left null takes the column default. The dealer''s own login is made by the API through Supabase Auth, not here. Returns the new tenant id.';
