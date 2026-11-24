-- ---------------------------------------------------------------------------
-- Who pays for the gift cards stops being a separate question.
--
-- The build screen had two controls sitting next to each other: a dropdown
-- for who SENDS the cards, and a tick box for whether the dealer is CHARGED
-- for them. They are not two questions. 50. buys the cards only when 50.
-- sends them, so:
--
--   reward_fulfillment = 'platform'  -> 50. buys the cards -> charge them
--   reward_fulfillment = 'dealer'    -> they buy their own -> charge nothing
--
-- Any other combination is a mistake, and one of them is an expensive,
-- silent mistake: set a dealer to "we send the cards" and leave the box
-- unticked, and 50. buys two gift cards per referral and bills for neither.
-- Nothing errors. Nothing warns. It just quietly costs the reward amount on
-- every referral that dealer closes, for as long as nobody notices.
--
-- So the column stops being something anyone can set. It is now GENERATED
-- from reward_fulfillment, which makes the wrong combination unrepresentable
-- rather than merely discouraged -- a tick box hidden in the UI would still
-- leave the API, PostgREST and psql able to write the two apart.
--
-- Every reader keeps working untouched: referralFee.js, billingEmails.js,
-- routes/me.js and db.js all still select charge_card_cost and still get a
-- boolean. Only writers had to change, and the two that existed (the pricing
-- PATCH and approve_lead_build) are changed with this migration.
-- ---------------------------------------------------------------------------
begin;

-- What this is about to change, named in the deploy log rather than applied
-- silently. A mismatch here is a dealer who has been billed wrongly, and
-- Joseph should see which one rather than find out from a Stripe total.
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, name, reward_fulfillment, charge_card_cost
      from tenants
     where charge_card_cost <> (reward_fulfillment = 'platform')
     order by name
  loop
    n := n + 1;
    raise notice 'CARD COST CORRECTED: % (%) — sends=%, was charged_for_cards=%, now %',
      r.name, r.id, r.reward_fulfillment, r.charge_card_cost, (r.reward_fulfillment = 'platform');
  end loop;
  if n = 0 then
    raise notice 'CARD COST: every company already agreed with who sends the cards. Nothing changed.';
  else
    raise notice 'CARD COST: % companies corrected. Check their recent referral fees.', n;
  end if;
end $$;

-- A plain column cannot be converted to a generated one in place.
alter table tenants drop column charge_card_cost;

alter table tenants
  add column charge_card_cost boolean
    generated always as (reward_fulfillment = 'platform') stored;

comment on column tenants.charge_card_cost is
  'Whether the gift cards face value is billed to this company on top of the referral fee. Not settable: generated from reward_fulfillment, because 50. buys the cards exactly when 50. sends them (see 20261124000000_card_cost_follows_fulfillment). To change it, change who sends the cards.';

comment on column tenants.reward_fulfillment is
  '''platform'' = 50. emails the gift cards to the customer and friend, and the cards are billed to the company; ''dealer'' = 50. emails the company and they send and pay for them. This column alone decides both -- charge_card_cost is generated from it.';

-- approve_lead_build loses its last argument. The old ten-argument version is
-- DROPPED rather than left beside the new one: two overloads differing only
-- by a trailing default is how a caller silently keeps hitting the old one.
drop function if exists approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text, boolean);

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
  p_reward_fulfillment text default null
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

  -- charge_card_cost is not in this insert and cannot be: it is generated
  -- from reward_fulfillment, which is the one thing set here.
  insert into tenants (
    slug, name, branding, reward_amount_cents,
    activation_fee_cents, annual_fee_cents, referral_fee_cents,
    reward_fulfillment
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
    coalesce(p_reward_fulfillment, 'dealer')
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

-- A newly created function is executable by PUBLIC until told otherwise, so
-- these have to be restated for the new signature -- the previous grants died
-- with the ten-argument function.
revoke all on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) from public, anon;
grant execute on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) to authenticated;
comment on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) is 'Admin only. Turns a won lead into a real 50. dealer: creates the tenant with its branding, gift card and the prices Joseph set on the build screen, puts the closing rep on it, and marks the lead built — all in one transaction. Any price left null takes the column default. Who sends the gift cards also decides who pays for them (tenants.charge_card_cost is generated), so there is no separate argument for it. The dealer''s own login is made by the API through Supabase Auth, not here. Returns the new tenant id.';

commit;
