-- The rep pipeline: reps sign in themselves, see only their own leads, their
-- own dealers and their own money, and the pay rule becomes closer-only.
--
-- One explicit transaction, like every other migration here. Safe to apply
-- before the API code that reads it: nothing existing reads the new columns,
-- and the one behaviour change to existing code is deliberate and described
-- under "What changes for code already running" below.
--
-- Three kinds of person now sign in to the 50. tenant itself:
--   - admin  (Joseph)  — everything, including every rep's money.
--   - staff  (helper)  — every rep's leads and dealers, no dollar amounts.
--   - rep    (new)     — ONLY their own leads, their own dealers and their own
--                        earnings and payouts. Never another rep's anything,
--                        never the pay rates, never a dealer they are not on.
--
-- What changes for code already running:
--   - is_platform_staff() is TIGHTENED. It used to mean "belongs to the 50.
--     tenant"; it now means "belongs to it as admin or staff". Reps are
--     deliberately excluded, so every policy and function already written
--     against it keeps the helper's access exactly as it was and gives a rep
--     nothing. A rep's own access is added alongside, as its own policies.
--   - rep_leads.status 'closed' becomes 'won'. The word the page shows and the
--     word in the database are now the same one.
--   - The onboarder's pay rates default to 0 (the closer now earns
--     everything). They are settings, not code, so they can be turned back on
--     from the Money tab without a migration.
begin;

-- ---------------------------------------------------------------------------
-- 1. A third role: 'rep'
-- ---------------------------------------------------------------------------
-- users.role has been ('admin','staff') since the role-rename migration. A rep
-- is an ordinary users row on the 50. tenant with this new role, linked to the
-- reps row it belongs to (reps.user_id below). Nothing compares against the
-- literal 'staff' anywhere; access is decided by the functions further down.
alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'staff', 'rep'));

comment on column users.role is '''admin'', ''staff'' or ''rep''. On the 50. tenant: admin is Joseph (sees all money), staff is the helper (all leads, no money), rep signs in to their own pipeline only (see the rep_pipeline migration). On a dealer''s own tenant only admin and staff are used.';

-- ---------------------------------------------------------------------------
-- 2. reps.user_id — the login a rep signs in with
-- ---------------------------------------------------------------------------
-- Nullable on purpose: a rep can exist with no login at all (someone who sells
-- but never signs in, or a rep added before they were invited). Set to null if
-- the login is ever deleted, so the rep's earnings history survives it.
alter table reps add column user_id uuid references users(id) on delete set null;
create unique index reps_user_id_idx on reps (user_id) where user_id is not null;

comment on column reps.user_id is 'The users row this rep signs in as, if they have been given a login. Null means no login yet: the rep exists, earns, and appears everywhere, but cannot sign in. One login per rep (unique).';

-- ---------------------------------------------------------------------------
-- 3. Who is calling
-- ---------------------------------------------------------------------------
-- is_platform_staff() is redefined, not replaced: every policy and function
-- already written against it now simply stops being true for a rep.
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
    where u.id = auth.uid() and t.slug = '50-platform' and u.role in ('admin', 'staff')
  )
$$;

comment on function is_platform_staff() is 'True if the caller belongs to the 50. tenant itself (slug 50-platform) as admin or staff. Deliberately FALSE for a rep: a rep''s access is granted by its own policies, scoped to current_rep_id(). security definer for the same reason as current_tenant_id().';

create or replace function is_platform_member() returns boolean
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

comment on function is_platform_member() is 'True for anyone signed in to the 50. tenant itself, reps included. Use it only for "may this person open the reps area at all"; what they may SEE inside it is decided by is_platform_staff(), is_platform_admin() and current_rep_id().';

-- Which rep the caller is, or null for anyone who is not one (Joseph, the
-- helper, a dealer, a signed-out visitor). Every rep-scoped policy below is
-- written as "= current_rep_id()", which is null for a non-rep and so matches
-- no row at all — a non-rep gets nothing from these policies and their own
-- staff/admin policy decides their access instead.
create or replace function current_rep_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id
  from reps r
  join users u on u.id = r.user_id
  join tenants t on t.id = u.tenant_id
  where r.user_id = auth.uid() and r.active and t.slug = '50-platform'
$$;

comment on function current_rep_id() is 'The reps.id of the signed-in rep, or null for anyone else. Null for an INACTIVE rep too, so deactivating a rep locks them out of the pipeline immediately while leaving their earnings intact. security definer: it reads reps and users, which the caller cannot read directly.';

revoke all on function is_platform_member() from public, anon;
revoke all on function current_rep_id() from public, anon;
grant execute on function is_platform_member() to authenticated;
grant execute on function current_rep_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The lead pipeline: a website, and Open / Won / Lost
-- ---------------------------------------------------------------------------
alter table rep_leads add column website text;
alter table rep_leads add column notes text;

comment on column rep_leads.notes is 'Whatever the rep wants to remember about this one, in their own words. From the next stage on, the brand files they drag onto the lead hang off it too.';
comment on column rep_leads.website is 'The prospect''s own website, as the rep typed it. Used to pull their logo and colors when the dealer is built; optional, because plenty of small builders do not have one (the rep uploads brand files instead).';

-- 'closed' -> 'won'. The constraint has to come off first because the rows it
-- guards are about to change value under it.
alter table rep_leads drop constraint rep_leads_closed_has_closer;
alter table rep_leads drop constraint rep_leads_status_check;
update rep_leads set status = 'won' where status = 'closed';
alter table rep_leads add constraint rep_leads_status_check check (status in ('open', 'won', 'lost'));
alter table rep_leads add constraint rep_leads_won_has_closer
  check (status <> 'won' or (closed_by_rep_id is not null and closed_on is not null));

comment on column rep_leads.status is '''open'', ''won'' or ''lost''. Won is what a rep toggles when the company agrees; it is the moment credit is fixed (closed_by_rep_id) and, from the next migration on, what puts the dealer in front of the admin to be built.';

-- A rep's own leads are the ones they brought in or closed, so both columns
-- are worth an index now that every rep's every page view filters on them.
create index rep_leads_closed_by_idx on rep_leads (closed_by_rep_id);

-- The duplicate check spans every rep's leads, which no rep may read. It runs
-- as the service role in the API and answers only "yes, someone has it" — this
-- index is what keeps that lookup cheap as the list grows.
create index rep_leads_company_name_lower_idx on rep_leads (lower(btrim(company_name)));

-- ---------------------------------------------------------------------------
-- 5. What a rep may see: their own, and nothing else
-- ---------------------------------------------------------------------------
-- These sit ALONGSIDE the existing staff and admin policies. Postgres ORs
-- policies of the same command together, so Joseph and the helper keep exactly
-- the access they had and a rep gets only what current_rep_id() matches.

-- Their own rep record (their name, so the page can greet them). Not other reps'.
create policy reps_own_select on reps
  for select to authenticated using (id = current_rep_id());

-- Their own leads: the ones they brought in, plus any they closed.
create policy rep_leads_own_select on rep_leads
  for select to authenticated
  using (brought_in_by_rep_id = current_rep_id() or closed_by_rep_id = current_rep_id());

-- A rep can only add a lead under their own name — not file one as another rep.
create policy rep_leads_own_insert on rep_leads
  for insert to authenticated
  with check (brought_in_by_rep_id = current_rep_id());

-- And can only edit a lead that is already theirs, and cannot hand it to
-- someone else or take someone else's: both the row before and the row after
-- have to be theirs.
create policy rep_leads_own_update on rep_leads
  for update to authenticated
  using (brought_in_by_rep_id = current_rep_id() or closed_by_rep_id = current_rep_id())
  with check (brought_in_by_rep_id = current_rep_id() or closed_by_rep_id = current_rep_id());

-- The dealers they are on, so they can see their own book of business.
create policy rep_assignments_own_select on rep_assignments
  for select to authenticated
  using (closer_rep_id = current_rep_id() or onboarder_rep_id = current_rep_id());

-- Their own money — read only, and only their own rows. A rep can never
-- insert, change or reverse an earning or record a payment to themselves:
-- there is no such policy, here or anywhere.
create policy rep_earnings_own_select on rep_earnings
  for select to authenticated using (rep_id = current_rep_id());

create policy rep_payouts_own_select on rep_payouts
  for select to authenticated using (rep_id = current_rep_id());

-- rep_settings (the pay rates) stays admin-only on purpose: a rep sees what
-- they earned, not the formula or what the rates might become.

-- ---------------------------------------------------------------------------
-- 6. The dealer list, now answering for reps too
-- ---------------------------------------------------------------------------
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
  where t.billing_required is true
    and (
      is_platform_staff()
      -- A rep sees only the dealers they are currently on. current_rep_id() is
      -- null for everyone else, so this half matches nothing for them.
      or (current_rep_id() is not null
          and (a.closer_rep_id = current_rep_id() or a.onboarder_rep_id = current_rep_id()))
    )
  order by t.created_at desc
$$;

comment on function rep_dealer_list() is 'Billing-required dealers with their current closer/onboarder. Joseph and the helper see every dealer; a rep sees only the ones they are currently on; anyone else gets an empty list. Never includes a dollar amount.';

-- ---------------------------------------------------------------------------
-- 7. The pay rule: the closer earns everything, the onboarder nothing
-- ---------------------------------------------------------------------------
-- The existing columns become the CLOSER's rates (unchanged: $50 and $1, 50
-- cents past the threshold). The onboarder gets its own three, all 0, so the
-- rule is "closer only" without deleting the onboarder idea — set them from
-- the Money tab to start paying an onboarder again, with no migration.
alter table rep_settings
  add column onboarder_activation_cents integer not null default 0
    check (onboarder_activation_cents >= 0),
  add column onboarder_referral_cents integer not null default 0
    check (onboarder_referral_cents >= 0),
  add column onboarder_referral_cents_after_threshold integer not null default 0
    check (onboarder_referral_cents_after_threshold >= 0);

comment on table rep_settings is 'The rep pay rates, one row. activation_cents and referral_cents are the CLOSER''s; the onboarder_* columns are the onboarder''s and are 0 by default, so by default the closer earns everything and the onboarder nothing. Both sides scale down in proportion when the per-card reward is under full_rate_card_cents (never up), and pay the after_threshold rate for referrals from a rep''s companies beyond the threshold_companies-th (counting companies where they were closer or onboarder, in the order those dealers activated).';

comment on column rep_settings.activation_cents is 'What the CLOSER earns when a dealer''s activation clears. The onboarder''s equivalent is onboarder_activation_cents.';
comment on column rep_settings.referral_cents is 'What the CLOSER earns per cleared referral fee, at a full-size card. The onboarder''s equivalent is onboarder_referral_cents.';

-- ---------------------------------------------------------------------------
-- 8. The duplicate check, without showing a rep another rep's prospect
-- ---------------------------------------------------------------------------
-- Two reps working the same company is the thing to catch, but a rep may not
-- read another rep's leads — so this runs above RLS (security definer) and
-- decides per row how much of it the caller is allowed to see:
--   - Joseph and the helper get the whole matching lead, as before.
--   - A rep gets their OWN matching lead in full, and for anyone else's only
--     the fact that it exists: the company name they themselves just typed,
--     and nothing else. No contact, no rep, no dates.
-- Anyone who is not on the 50. tenant gets nothing at all.
create or replace function rep_lead_duplicates(
  p_company text,
  p_phone text default null,
  p_email text default null,
  p_exclude uuid default null
) returns table (
  id uuid,
  company_name text,
  contact_name text,
  phone text,
  email text,
  found_on date,
  status text,
  brought_in_by_rep_id uuid,
  mine boolean,
  visible boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select current_rep_id() as rep_id, is_platform_staff() as staff),
  hit as (
    select l.*
    from rep_leads l, me
    where (me.staff or me.rep_id is not null)
      and (p_exclude is null or l.id <> p_exclude)
      and (
        regexp_replace(lower(btrim(l.company_name)), '\s+', '', 'g')
          = regexp_replace(lower(btrim(p_company)), '\s+', '', 'g')
        or (p_phone is not null and length(regexp_replace(p_phone, '\D', '', 'g')) >= 7
            and regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g'))
        or (p_email is not null and btrim(p_email) <> '' and lower(l.email) = lower(btrim(p_email)))
      )
  )
  select h.id,
         h.company_name,
         case when v.show then h.contact_name end,
         case when v.show then h.phone end,
         case when v.show then h.email end,
         case when v.show then h.found_on end,
         case when v.show then h.status end,
         case when v.show then h.brought_in_by_rep_id end,
         (me.rep_id is not null and h.brought_in_by_rep_id = me.rep_id),
         v.show
  from hit h, me,
       lateral (select (me.staff or h.brought_in_by_rep_id = me.rep_id or h.closed_by_rep_id = me.rep_id) as show) v
  order by h.created_at
  limit 10
$$;

revoke all on function rep_lead_duplicates(text, text, text, uuid) from public, anon;
grant execute on function rep_lead_duplicates(text, text, text, uuid) to authenticated;

comment on function rep_lead_duplicates(text, text, text, uuid) is 'Leads that look like the same company (same name ignoring case and spacing, same phone digits, or same email). Staff see the whole row; a rep sees their own in full and, for another rep''s, only that it exists (visible = false) so the page can warn them off without naming who has it.';

commit;
