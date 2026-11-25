-- ---------------------------------------------------------------------------
-- Agency reps: someone who sells 50. for a living but is not on 50.'s books.
--
-- Angela works for SmartScale Global, which sells 50. on a contract of its
-- own. She is a rep in every way that matters to the pipeline -- she brings in
-- leads, works them, wins them -- and in no way that matters to payroll. Two
-- things follow, and neither fitted the rep record as it stood:
--
--   1. She is paid by her own company on their own terms, so none of 50.'s
--      rep money applies to her. Showing her a My Money tab reading $0 owed
--      would not be a blank page; it would be a wrong one.
--   2. She builds her companies' dashboards herself. That was Joseph's alone,
--      and it is the whole point of the arrangement that it stops being.
--
-- The second one is where the care goes, because the build screen is also
-- where a company's prices are set. An outside agency that could set 50.'s
-- prices would be an agency that could sign a company up for nothing.
--
-- So an agency rep builds the whole dashboard, and the prices are not hers:
--
--   onboarding ($500)   locked to the standard
--   every year ($100)   locked to the standard
--   the gift card       HERS -- the one thing she negotiates
--   fee per referral    30% of what the two cards cost, worked out from the
--                       card she chose. $50 card -> $30. $25 card -> $15.
--   who sends the cards locked to the company sending their own
--
-- That is enforced HERE and not on the build screen, because a screen can be
-- skipped: approve_lead_build is the only way a dealer is ever created, and
-- below it simply does not read the locked arguments when the caller is not
-- Joseph. A hand-written POST gets the same prices the screen shows.
-- ---------------------------------------------------------------------------
begin;

alter table reps
  -- 'rep'    -- on 50.'s own rep program: earns the $50 a close and the
  --             per-referral share, sees My Money, cannot build.
  -- 'agency' -- sells 50. for an outside company on its own contract: no 50.
  --             earnings at all, builds their own dealers.
  add column kind text not null default 'rep'
    check (kind in ('rep', 'agency')),
  -- Who they sell for, when it is not 50. Shown beside their name and used in
  -- the weekly report, so a second SmartScale person is obviously the same
  -- outfit rather than a second unexplained name.
  add column company text;

comment on column reps.kind is
  '''rep'' = on 50.''s rep program and paid by 50.; ''agency'' = sells 50. for an outside company on its own contract, so earns nothing here and builds their own dealers. See 20261125000000_agency_reps.';
comment on column reps.company is
  'The outside company an agency rep sells for (SmartScale Global). Null for 50.''s own reps.';

-- An agency rep must name who they sell for: "agency" with no company is a
-- rep whose pay structure nobody can look up.
alter table reps
  add constraint reps_agency_has_company
    check (kind <> 'agency' or coalesce(btrim(company), '') <> '');

-- ---------------------------------------------------------------------------
-- Who may build a dealer.

create or replace function current_agency_rep_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id
  from reps r
  join users u on u.id = r.user_id
  join tenants t on t.id = u.tenant_id
  where r.user_id = auth.uid()
    and r.active
    and r.kind = 'agency'
    and t.slug = '50-platform'
$$;

comment on function current_agency_rep_id() is 'The reps.id of the signed-in rep when they are an ACTIVE agency rep, and null for everyone else — 50.''s own reps included. Switching an agency rep off takes their build rights away the same moment it takes their pipeline away. security definer: it reads reps and users, which the caller cannot read directly.';

create or replace function can_build_dealers() returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select is_platform_admin() or current_agency_rep_id() is not null
$$;

comment on function can_build_dealers() is 'True for Joseph, and for an active agency rep. The ONE test for who may turn a won lead into a live dealer. An agency rep gets the standard prices whatever they send — see approve_lead_build.';

revoke all on function current_agency_rep_id() from public, anon;
revoke all on function can_build_dealers() from public, anon;
grant execute on function current_agency_rep_id() to authenticated;
grant execute on function can_build_dealers() to authenticated;

-- ---------------------------------------------------------------------------
-- approve_lead_build, with the prices an agency rep does not get to set.

drop function if exists approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text);

create or replace function approve_lead_build(
  p_lead_id uuid,
  p_slug text,
  p_name text,
  p_brand jsonb,
  p_reward_amount_cents integer default null,
  -- Joseph sets each dealer's prices himself on the build screen. Null on any
  -- of these means "leave it at the column default", so a build that sends
  -- nothing behaves exactly as it did before they existed. An agency rep's
  -- build ignores them entirely, whatever it sends.
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
  v_agency_rep uuid;
  v_reward integer;
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

  -- billing_required defaults to true, which is what gates them into paying
  -- the $500 at their first sign-in. Never set it here: the three exempt
  -- tenants are fixed in the schema and a built dealer is never one of them.
  if p_reward_fulfillment is not null and p_reward_fulfillment not in ('dealer', 'platform') then
    raise exception 'reward_fulfillment must be dealer or platform' using errcode = '22023';
  end if;

  if v_agency_rep is null then
    -- Joseph. Every price is his, and anything he left alone takes the
    -- column default. charge_card_cost is absent because it is generated.
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
      coalesce(p_activation_fee_cents, 50000),
      coalesce(p_annual_fee_cents, 10000),
      coalesce(p_referral_fee_cents, 3000),
      coalesce(p_reward_fulfillment, 'dealer')
    )
    returning id into v_tenant_id;
  else
    -- An agency rep. The gift card is the one thing they chose; everything
    -- else is 50.'s to decide, so activation_fee_cents, annual_fee_cents and
    -- reward_fulfillment are left OUT of the insert and take the column
    -- default. Leaving them out rather than naming today's numbers means
    -- "standard" keeps meaning whatever Joseph has made it, with nothing
    -- here to fall out of step with him.
    v_reward := coalesce(p_reward_amount_cents, 5000);
    insert into tenants (
      slug, name, branding, reward_amount_cents, referral_fee_cents
    )
    values (
      v_slug,
      btrim(p_name),
      coalesce(p_brand, '{}'::jsonb),
      v_reward,
      -- 30% of what the two cards cost, which is what the old percentage fee
      -- came to on the standard program: a $50 card is a $100 payout is $30.
      -- Worked out from the card she chose, so a smaller card she negotiates
      -- is a smaller fee rather than a quiet discount on 50.'s margin.
      round(v_reward * 2 * 0.30)::integer
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

revoke all on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) from public, anon;
grant execute on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) to authenticated;
comment on function approve_lead_build(uuid, text, text, jsonb, integer, integer, integer, integer, text) is 'Joseph, or an active agency rep on their OWN won lead. Turns a won lead into a live 50. dealer in one transaction: creates the tenant with its branding and prices, puts the closing rep on it, and marks the lead built. An agency rep''s build takes the standard onboarding and yearly prices and a referral fee of 30% of the two cards, whatever the request sends — only the gift card amount is theirs. The dealer''s own login is made by the API through Supabase Auth, not here. Returns the new tenant id.';

-- ---------------------------------------------------------------------------
-- An agency rep never earns from 50.
--
-- This is the failure Joseph cares about most -- money that appears where it
-- was never owed. Angela is paid by SmartScale on SmartScale's terms, so a
-- $50 close credit landing in her rep_earnings is not a cosmetic bug: it is a
-- balance someone could pay out twice.
--
-- The earnings worker is changed to skip agency reps (workers/repEarnings.js),
-- which is what actually keeps the rows from being written. This trigger is
-- the second lock, for every other way a row could get in -- a hand-written
-- insert, a future worker, a backfill script. The worker's own statements
-- filter these rows out before they are built, so this never fires on the
-- ordinary path and a raise here is always a real mistake.
create or replace function rep_earnings_reject_agency() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select name into v_name from reps where id = new.rep_id and kind = 'agency';
  if found then
    raise exception '% sells 50. for an outside company and earns nothing here — this earning should not exist', v_name
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger rep_earnings_reject_agency
  before insert or update of rep_id on rep_earnings
  for each row execute function rep_earnings_reject_agency();

comment on function rep_earnings_reject_agency() is 'Refuses any rep_earnings row for an agency rep, who is paid by their own company and never by 50. The earnings worker already skips them; this catches every other route in. See 20261125000000_agency_reps.';

commit;
