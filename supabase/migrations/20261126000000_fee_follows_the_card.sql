-- ---------------------------------------------------------------------------
-- The fee per referral stops being a question.
--
-- It has always been 30% of what the two gift cards cost. That is what the
-- old percentage fee came to, it is what every paying company on the platform
-- is on today, and it is what Joseph quotes. Yet the build screen and the
-- pricing screen both asked for it as a number, which means there were two
-- ways for it to be wrong: a typo, and a gift card changed afterwards while
-- the fee stayed where it was. The second one is the quiet one -- halve a
-- company's gift card and 50. keeps charging the old fee on a smaller payout,
-- with nothing on any screen looking amiss.
--
-- So the fee is generated now, like charge_card_cost before it:
--
--   billing_required  ->  30% of (gift card x 2)
--   in-house          ->  nothing, ever
--
-- The in-house half matters. Good Steward, North Mountain and 50. itself are
-- permanently exempt and sit at $0 across the board. A flat "always 30%"
-- would have moved all three to $30 -- a figure nothing would charge today,
-- because billing_required is false, but one that would start being real the
-- day anybody flipped that flag. Their zero is a fact about them, not an
-- empty box, so the expression keeps it.
--
-- NOBODY IS RE-PRICED. Every paying company is already at exactly 30% of a
-- $50 card, and every exempt one is already at zero, so this expression
-- reproduces all seven rows unchanged. The block below proves that rather
-- than asserting it, and names any row it would have moved.
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select name, billing_required, reward_amount_cents, referral_fee_cents,
           case when billing_required
                then round(reward_amount_cents * 2 * 0.30)::integer
                else 0 end as becomes
      from tenants
     where referral_fee_cents is distinct from
           (case when billing_required
                 then round(reward_amount_cents * 2 * 0.30)::integer
                 else 0 end)
     order by name
  loop
    n := n + 1;
    raise notice 'FEE CHANGED: % — was %c, now %c (gift card %c, billing_required %)',
      r.name, r.referral_fee_cents, r.becomes, r.reward_amount_cents, r.billing_required;
  end loop;
  if n = 0 then
    raise notice 'FEE: every company was already on the rule. No bill changes.';
  else
    raise notice 'FEE: % companies moved. Check their next invoice.', n;
  end if;
end $$;

alter table tenants drop column referral_fee_cents;

alter table tenants
  add column referral_fee_cents integer
    generated always as (
      case when billing_required
           then round(reward_amount_cents * 2 * 0.30)::integer
           else 0 end
    ) stored;

comment on column tenants.referral_fee_cents is
  '50.''s fee each time a referral is marked rewarded. Not settable: generated as 30% of what the two gift cards cost, and 0 for a permanently in-house company. Change the gift card and the fee follows it. See 20261126000000_fee_follows_the_card and api/src/lib/referralFee.js.';

comment on column tenants.reward_amount_cents is
  'What each side of a referral gets as an e-gift card. The one number that decides the money on a company: the payout is twice this, and referral_fee_cents is generated as 30% of that payout.';

-- ---------------------------------------------------------------------------
-- approve_lead_build drops its fee argument.

drop function if exists approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text);

create or replace function approve_lead_build(
  p_lead_id uuid,
  p_slug text,
  p_name text,
  p_brand jsonb,
  p_reward_amount_cents integer default null,
  -- Joseph sets these two himself on the build screen; null on either means
  -- "leave it at the column default". There is no fee argument any more: the
  -- fee comes from the gift card above. An agency rep's build ignores both of
  -- these and the fulfillment below, whatever it sends.
  p_activation_fee_cents integer default null,
  p_annual_fee_cents integer default null,
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
  v_agency_rep uuid;
begin
  if not can_build_dealers() then
    raise exception 'Only the 50. admin or an agency rep can build a dealer' using errcode = '42501';
  end if;
  v_agency_rep := current_agency_rep_id();

  select * into v_lead from rep_leads where id = p_lead_id for update;
  if not found then
    raise exception 'No such lead' using errcode = 'P0002';
  end if;

  -- An agency rep builds their OWN won leads and nobody else's. RLS would
  -- normally say so, but this function is security definer and the SELECT
  -- above saw every row, so the check has to be made in the open.
  if v_agency_rep is not null
     and v_lead.closed_by_rep_id is distinct from v_agency_rep
     and v_lead.brought_in_by_rep_id is distinct from v_agency_rep then
    raise exception 'That lead is not yours to build' using errcode = '42501';
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

  if p_reward_fulfillment is not null and p_reward_fulfillment not in ('dealer', 'platform') then
    raise exception 'reward_fulfillment must be dealer or platform' using errcode = '22023';
  end if;

  -- Two generated columns are deliberately absent from both inserts:
  -- referral_fee_cents (30% of the card) and charge_card_cost (who sends
  -- them). billing_required is absent too and defaults to true, which is what
  -- gates a new dealer into paying the $500 at their first sign-in; the three
  -- exempt tenants are fixed in the schema and a built dealer is never one.
  if v_agency_rep is null then
    -- Joseph. The gift card and the two fixed prices are his.
    insert into tenants (
      slug, name, branding, reward_amount_cents,
      activation_fee_cents, annual_fee_cents, reward_fulfillment
    )
    values (
      v_slug,
      btrim(p_name),
      coalesce(p_brand, '{}'::jsonb),
      coalesce(p_reward_amount_cents, 5000),
      coalesce(p_activation_fee_cents, 50000),
      coalesce(p_annual_fee_cents, 10000),
      coalesce(p_reward_fulfillment, 'dealer')
    )
    returning id into v_tenant_id;
  else
    -- An agency rep. The gift card is the one thing they chose; everything
    -- else is left OUT of the insert and takes the column default, so
    -- "standard" keeps meaning whatever Joseph has made it rather than a
    -- number copied here that could fall out of step with him.
    insert into tenants (slug, name, branding, reward_amount_cents)
    values (
      v_slug,
      btrim(p_name),
      coalesce(p_brand, '{}'::jsonb),
      coalesce(p_reward_amount_cents, 5000)
    )
    returning id into v_tenant_id;
  end if;

  update rep_leads
     set tenant_id = v_tenant_id,
         build_status = 'built',
         built_at = now(),
         approved_by = auth.uid(),
         brand = coalesce(p_brand, brand),
         reward_amount_cents = p_reward_amount_cents
   where id = p_lead_id;

  -- The rep who closed it goes on the dealer, which is what earns them the
  -- $50 once the activation clears. An agency rep earns nothing from 50., so
  -- the assignment is what puts the company on their Companies tab and
  -- nothing more -- the earnings worker skips them on kind.
  if v_lead.closed_by_rep_id is not null or v_lead.onboarded_by_rep_id is not null then
    insert into rep_assignments (tenant_id, closer_rep_id, onboarder_rep_id, effective_from)
    values (v_tenant_id, v_lead.closed_by_rep_id, v_lead.onboarded_by_rep_id, now());
  end if;

  return v_tenant_id;
end;
$$;

revoke all on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, text) from public, anon;
grant execute on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, text) to authenticated;
comment on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, text) is 'Joseph, or an active agency rep on their OWN won lead. Turns a won lead into a live 50. dealer in one transaction. The fee per referral is not an argument — it is generated from the gift card. An agency rep''s build takes the standard onboarding and yearly prices and dealer-sent cards whatever the request sends; only the gift card is theirs. Returns the new tenant id.';

commit;
