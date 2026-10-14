-- Sales-rep program: who sold and onboarded each 50. dealer, the leads reps
-- bring in, what each rep has earned, and what 50. has paid them.
--
-- One explicit transaction, like the other billing migrations: all of it
-- lands or none of it does. Safe to apply before the API code that reads it
-- (nothing existing reads these tables).
--
-- Who may see what (enforced here, by Postgres, not only by the API):
--   - The "50." tenant's own staff (tenants.slug = '50-platform') manage reps,
--     leads and which rep is on which dealer. Nobody else can see any of it:
--     a dealer's own login can't read these tables.
--   - Everything about MONEY — settings (the pay rates), earnings, payouts —
--     is readable only by the 50. tenant's ADMIN. The 50. tenant's ordinary
--     staff (the helper who enters leads) sees no dollar amounts at all.
--   - Earnings are only ever written by the hourly worker
--     (workers/repEarnings.js, service role) and by the admin-only
--     reverse_rep_earning() below. A rep's start date on a dealer is set by
--     assign_rep(): staff can only start it "now"; only the admin can backdate.
begin;

-- ---------------------------------------------------------------------------
-- Who is calling: staff of the 50. tenant itself, and its admin
-- ---------------------------------------------------------------------------
create or replace function is_platform_staff() returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from users u
    join tenants t on t.id = u.tenant_id
    where u.id = auth.uid() and t.slug = '50-platform'
  )
$$;

create or replace function is_platform_admin() returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from users u
    join tenants t on t.id = u.tenant_id
    where u.id = auth.uid() and u.role = 'admin' and t.slug = '50-platform'
  )
$$;

comment on function is_platform_staff() is 'True if the calling staff user belongs to the 50. tenant itself (slug 50-platform). security definer for the same reason as current_tenant_id().';
comment on function is_platform_admin() is 'True if the calling staff user is an admin of the 50. tenant itself. Gates everything about rep money.';

-- ---------------------------------------------------------------------------
-- reps
-- ---------------------------------------------------------------------------
create table reps (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  email       text,
  phone       text,
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);

comment on table reps is 'A person who sells 50. to dealers (as the closer) or onboards them. Rep contact details only — what they earn is in rep_earnings.';
comment on column reps.active is 'False once 50. stops working with them. Deactivating does not move their dealers or stop their royalties — the admin decides that dealer by dealer (assign_rep).';

alter table reps enable row level security;
revoke all on reps from anon, authenticated;
grant select, insert, update on reps to authenticated;
create policy reps_platform_staff_select on reps for select to authenticated using (is_platform_staff());
create policy reps_platform_staff_insert on reps for insert to authenticated with check (is_platform_staff());
create policy reps_platform_staff_update on reps for update to authenticated using (is_platform_staff()) with check (is_platform_staff());

-- ---------------------------------------------------------------------------
-- rep_leads — companies a rep has brought in, before (and after) they sign
-- ---------------------------------------------------------------------------
create table rep_leads (
  id                    uuid primary key default gen_random_uuid(),
  company_name          text not null check (length(btrim(company_name)) > 0),
  contact_name          text,
  phone                 text,
  email                 text,
  brought_in_by_rep_id  uuid references reps(id),
  found_on              date not null default current_date,
  status                text not null default 'open' check (status in ('open', 'closed', 'lost')),
  closed_by_rep_id      uuid references reps(id),
  onboarded_by_rep_id   uuid references reps(id),
  closed_on             date,
  tenant_id             uuid references tenants(id),
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  constraint rep_leads_closed_has_closer check (status <> 'closed' or (closed_by_rep_id is not null and closed_on is not null))
);

create index rep_leads_brought_in_by_idx on rep_leads (brought_in_by_rep_id);
create index rep_leads_status_idx on rep_leads (status);
create unique index rep_leads_one_per_tenant_idx on rep_leads (tenant_id) where tenant_id is not null;

comment on table rep_leads is 'A prospective (or signed) dealer a rep brought in. Credit goes to whoever CLOSES the lead (closed_by_rep_id), not to whoever found it; the finder is recorded and earns nothing. The money follows rep_assignments, not this table.';

alter table rep_leads enable row level security;
revoke all on rep_leads from anon, authenticated;
grant select, insert, update on rep_leads to authenticated;
create policy rep_leads_platform_staff_select on rep_leads for select to authenticated using (is_platform_staff());
create policy rep_leads_platform_staff_insert on rep_leads for insert to authenticated with check (is_platform_staff());
create policy rep_leads_platform_staff_update on rep_leads for update to authenticated using (is_platform_staff()) with check (is_platform_staff());

-- ---------------------------------------------------------------------------
-- rep_assignments — which rep closed and which onboarded each dealer, with
-- history: a reassignment closes the old row (effective_to) and opens a new
-- one, so every charge is credited to whoever held the dealer when it cleared.
-- A dealer with no current row is a house account and earns nobody anything.
-- ---------------------------------------------------------------------------
create table rep_assignments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  closer_rep_id     uuid references reps(id),
  onboarder_rep_id  uuid references reps(id),
  effective_from    timestamptz not null default now(),
  effective_to      timestamptz,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  constraint rep_assignments_has_a_rep check (closer_rep_id is not null or onboarder_rep_id is not null),
  constraint rep_assignments_period_order check (effective_to is null or effective_to >= effective_from)
);

create unique index rep_assignments_one_current_idx on rep_assignments (tenant_id) where effective_to is null;
create index rep_assignments_tenant_idx on rep_assignments (tenant_id, effective_from);
create index rep_assignments_closer_idx on rep_assignments (closer_rep_id);
create index rep_assignments_onboarder_idx on rep_assignments (onboarder_rep_id);

comment on table rep_assignments is 'Closer and onboarder for a dealer over a period. Written only by assign_rep(). A charge earns its rep royalties only if it cleared inside a period here; Silver Run and Black Brothers have no rows (house accounts).';
comment on column rep_assignments.effective_from is 'When this assignment started counting. Charges that cleared before it earn nothing for these reps. Only the admin can set it earlier than now.';

alter table rep_assignments enable row level security;
revoke all on rep_assignments from anon, authenticated;
grant select on rep_assignments to authenticated;
create policy rep_assignments_platform_staff_select on rep_assignments for select to authenticated using (is_platform_staff());

-- The one way to change who is on a dealer.
create or replace function assign_rep(
  p_tenant_id uuid,
  p_closer_rep_id uuid,
  p_onboarder_rep_id uuid,
  p_effective_from timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz;
  v_current rep_assignments%rowtype;
  v_billable boolean;
  v_id uuid;
begin
  if not is_platform_staff() then
    raise exception 'Only 50. staff can assign reps' using errcode = '42501';
  end if;
  if p_effective_from is not null and not is_platform_admin() then
    raise exception 'Only the 50. admin can set a start date' using errcode = '42501';
  end if;

  select billing_required into v_billable from tenants where id = p_tenant_id;
  if not found then
    raise exception 'No such dealer' using errcode = 'P0002';
  end if;
  if v_billable is distinct from true then
    raise exception 'This account is billing-exempt, so reps cannot earn on it' using errcode = '22023';
  end if;

  v_from := coalesce(p_effective_from, now());
  select * into v_current from rep_assignments where tenant_id = p_tenant_id and effective_to is null for update;

  if found then
    if v_current.closer_rep_id is not distinct from p_closer_rep_id
       and v_current.onboarder_rep_id is not distinct from p_onboarder_rep_id then
      -- Same reps. The only thing that can change is an earlier start (the
      -- admin crediting a payment that cleared before the assignment was
      -- made), and not into the period of an earlier assignment.
      if p_effective_from is not null and v_from < v_current.effective_from then
        if exists (select 1 from rep_assignments where tenant_id = p_tenant_id and id <> v_current.id and effective_to > v_from) then
          raise exception 'That start date overlaps an earlier assignment of this dealer' using errcode = '22023';
        end if;
        update rep_assignments set effective_from = v_from where id = v_current.id;
      end if;
      return v_current.id;
    end if;
    if v_from < v_current.effective_from then
      raise exception 'The new assignment cannot start before the current one (%)', v_current.effective_from using errcode = '22023';
    end if;
    update rep_assignments set effective_to = v_from where id = v_current.id;
  end if;

  if p_closer_rep_id is null and p_onboarder_rep_id is null then
    return null; -- back to a house account
  end if;

  insert into rep_assignments (tenant_id, closer_rep_id, onboarder_rep_id, effective_from)
  values (p_tenant_id, p_closer_rep_id, p_onboarder_rep_id, v_from)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function assign_rep(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function assign_rep(uuid, uuid, uuid, timestamptz) to authenticated;

comment on function assign_rep(uuid, uuid, uuid, timestamptz) is 'Sets who closed and who onboarded a billing-required dealer, from now (staff) or from a given moment (admin only). Closes the previous assignment so earlier charges stay with the earlier reps (the admin can also move an unchanged assignment''s start earlier). Both reps null = house account. Returns the new assignment id.';

-- The dealer list the reps page needs. The tenants table itself is visible
-- only to each tenant's own staff, so the helper gets this narrow view: which
-- dealers exist, whether they have activated, and who is on them. No money.
create or replace function rep_dealer_list() returns table (
  tenant_id uuid,
  name text,
  slug text,
  activated boolean,
  activated_on date,
  closer_rep_id uuid,
  onboarder_rep_id uuid,
  assigned_from timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.name, t.slug,
         (t.activation_paid_at is not null and t.activation_livemode is true),
         case when t.activation_livemode is true then t.activation_paid_at::date end,
         a.closer_rep_id, a.onboarder_rep_id, a.effective_from
  from tenants t
  left join rep_assignments a on a.tenant_id = t.id and a.effective_to is null
  where is_platform_staff() and t.billing_required is true
  order by t.created_at desc
$$;

revoke all on function rep_dealer_list() from public, anon;
grant execute on function rep_dealer_list() to authenticated;

comment on function rep_dealer_list() is 'Billing-required dealers with their current closer/onboarder, for the 50. staff reps page. Empty for anyone who is not 50. staff. Never includes a dollar amount.';

-- ---------------------------------------------------------------------------
-- rep_settings — the pay rates (one row). Money: admin only.
-- ---------------------------------------------------------------------------
create table rep_settings (
  id                                boolean primary key default true check (id),
  activation_cents                  integer not null default 5000 check (activation_cents >= 0),
  referral_cents                    integer not null default 100 check (referral_cents >= 0),
  referral_cents_after_threshold    integer not null default 50 check (referral_cents_after_threshold >= 0),
  threshold_companies               integer not null default 2000 check (threshold_companies > 0),
  full_rate_card_cents              integer not null default 5000 check (full_rate_card_cents > 0),
  updated_at                        timestamptz not null default now()
);

insert into rep_settings default values;

comment on table rep_settings is 'The rep pay rates, one row. Each of the closer and the onboarder earns activation_cents when a dealer''s activation clears, and referral_cents per cleared referral fee — scaled down in proportion when the per-card reward is under full_rate_card_cents (never scaled up), and paid at referral_cents_after_threshold for referrals from a rep''s companies beyond the threshold_companies-th (counting companies where they were closer or onboarder, in the order those dealers activated).';

alter table rep_settings enable row level security;
revoke all on rep_settings from anon, authenticated;
grant select, update on rep_settings to authenticated;
create policy rep_settings_admin_select on rep_settings for select to authenticated using (is_platform_admin());
create policy rep_settings_admin_update on rep_settings for update to authenticated using (is_platform_admin()) with check (is_platform_admin());

-- ---------------------------------------------------------------------------
-- rep_earnings — the ledger of what each rep has earned. Money: admin only.
-- Positive rows are earnings; a refund/dispute adds a negative 'reversal'
-- row that points at the row it undoes (nothing is ever edited or deleted).
-- ---------------------------------------------------------------------------
create table rep_earnings (
  id                       uuid primary key default gen_random_uuid(),
  rep_id                   uuid not null references reps(id),
  tenant_id                uuid not null references tenants(id),
  role                     text not null check (role in ('closer', 'onboarder')),
  kind                     text not null check (kind in ('activation', 'referral', 'reversal')),
  amount_cents             integer not null,
  source_billing_event_id  uuid references billing_events(id),
  reverses_earning_id      uuid references rep_earnings(id),
  earned_at                timestamptz not null,
  detail                   jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  constraint rep_earnings_sign check (
    (kind = 'reversal' and reverses_earning_id is not null and amount_cents <= 0)
    or (kind <> 'reversal' and reverses_earning_id is null and amount_cents > 0 and source_billing_event_id is not null)
  )
);

-- Exactly once: a charge earns each (rep, role) once, and an earning is
-- reversed at most once.
create unique index rep_earnings_one_per_charge_idx
  on rep_earnings (source_billing_event_id, rep_id, role) where kind <> 'reversal';
create unique index rep_earnings_one_reversal_idx
  on rep_earnings (reverses_earning_id) where kind = 'reversal';
create index rep_earnings_rep_idx on rep_earnings (rep_id, earned_at);
create index rep_earnings_tenant_idx on rep_earnings (tenant_id);

comment on table rep_earnings is 'What each rep earned: a row per rep and role for every cleared live activation or referral fee that landed while they were assigned to the dealer, and a negative reversal row when that charge is later refunded or disputed (or the admin reverses it by hand). Written only by workers/repEarnings.js and reverse_rep_earning(). Admin-only to read.';
comment on column rep_earnings.detail is 'How the amount was worked out (rate, per-card reward, scale, the rep''s company number) — for answering "why this much?" later.';

alter table rep_earnings enable row level security;
revoke all on rep_earnings from anon, authenticated;
grant select on rep_earnings to authenticated;
create policy rep_earnings_admin_select on rep_earnings for select to authenticated using (is_platform_admin());

-- Reverse one earning by hand (e.g. a refund done in the Stripe dashboard,
-- which 50. does not hear about). Admin only.
create or replace function reverse_rep_earning(p_earning_id uuid, p_note text default null) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_e rep_earnings%rowtype;
  v_id uuid;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can reverse earnings' using errcode = '42501';
  end if;
  select * into v_e from rep_earnings where id = p_earning_id;
  if not found then
    raise exception 'No such earning' using errcode = 'P0002';
  end if;
  if v_e.kind = 'reversal' then
    raise exception 'That row is already a reversal' using errcode = '22023';
  end if;
  if exists (select 1 from rep_earnings where reverses_earning_id = p_earning_id) then
    raise exception 'That earning has already been reversed' using errcode = '22023';
  end if;
  insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, reverses_earning_id, earned_at, detail)
  values (v_e.rep_id, v_e.tenant_id, v_e.role, 'reversal', -v_e.amount_cents, v_e.id, now(),
          jsonb_build_object('reason', 'manual', 'note', p_note))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function reverse_rep_earning(uuid, text) from public, anon;
grant execute on function reverse_rep_earning(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- rep_payouts — what 50. has paid each rep. Money: admin only.
-- ---------------------------------------------------------------------------
create table rep_payouts (
  id            uuid primary key default gen_random_uuid(),
  rep_id        uuid not null references reps(id),
  amount_cents  integer not null check (amount_cents > 0),
  paid_on       date not null default current_date,
  period        text check (period is null or period ~ '^[0-9]{4}-[0-9]{2}$'),
  method        text,
  note          text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create index rep_payouts_rep_idx on rep_payouts (rep_id, paid_on);

comment on table rep_payouts is 'A payment 50. made to a rep, recorded by the admin when they click Paid. What 50. still owes a rep = their earnings (including reversals) minus their payouts. period is the statement month it was paid against, if any.';

alter table rep_payouts enable row level security;
revoke all on rep_payouts from anon, authenticated;
grant select, insert, delete on rep_payouts to authenticated;
create policy rep_payouts_admin_select on rep_payouts for select to authenticated using (is_platform_admin());
create policy rep_payouts_admin_insert on rep_payouts for insert to authenticated with check (is_platform_admin());
create policy rep_payouts_admin_delete on rep_payouts for delete to authenticated using (is_platform_admin());

commit;
