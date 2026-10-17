-- Put a lead on the calendar the day it is added.
--
-- Joseph: "when a rep or myself enters a new lead, I want it to automatically
-- be added to the calendar showing that so-and-so lead was added to the
-- calendar on this date. That should be automatic."
--
-- One more branch in rep_calendar(), scoped exactly like the three milestones
-- already there: 50. staff see every company's, a rep sees only leads they
-- brought in or closed, and nobody else sees anything. Nothing is stored — the
-- lead row already records the date, so this is read live like the rest and a
-- deleted lead takes its mark with it.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. The page's wording
-- for the new 'lead_added' kind ships with the deploy; applying this first
-- only means the mark appears, labelled from the page's fallback, a few
-- minutes early.
begin;

create or replace function rep_calendar(p_from date, p_to date) returns table (
  kind        text,
  on_date     date,
  at_time     time,
  title       text,
  detail      text,
  followup_id uuid,
  lead_id     uuid,
  tenant_id   uuid,
  done        boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid()            as user_id,
           current_rep_id()      as rep_id,
           is_platform_staff()   as staff,
           is_platform_member()  as member
  )
  -- Your own follow-ups, done ones included so the page can show them ticked.
  select 'followup'::text, f.due_on, f.due_time,
         f.title, f.note, f.id, f.lead_id, f.tenant_id, (f.done_at is not null)
  from rep_followups f, me
  where me.member
    and f.user_id = me.user_id
    and f.due_on between p_from and p_to

  union all
  -- A lead being added. Joseph asked for this: when anyone enters a new lead he
  -- wants it on the calendar as of the day it went in, without having to write
  -- a follow-up for it.
  --
  -- found_on, not created_at: the lead form has a date box that defaults to
  -- today and the rep can change it, so found_on is the day THEY say they found
  -- the company. created_at would say when they got round to typing it, which
  -- is a different and less useful fact.
  select 'lead_added'::text, l.found_on, null::time,
         l.company_name, null::text, null::uuid, l.id, l.tenant_id, true
  from rep_leads l, me
  where me.member
    and l.found_on between p_from and p_to
    and (me.staff
         or (me.rep_id is not null
             and (l.brought_in_by_rep_id = me.rep_id or l.closed_by_rep_id = me.rep_id)))

  union all
  -- A lead that said yes. The status is 'won' (the pipeline migration renamed it
  -- from 'closed'; rep_leads.closed_on kept its older name).
  select 'lead_won'::text, l.closed_on, null::time,
         l.company_name, null::text, null::uuid, l.id, l.tenant_id, true
  from rep_leads l, me
  where me.member
    and l.status = 'won'
    and l.closed_on between p_from and p_to
    and (me.staff
         or (me.rep_id is not null
             and (l.brought_in_by_rep_id = me.rep_id or l.closed_by_rep_id = me.rep_id)))

  union all
  -- A dashboard built and handed over.
  select 'dealer_built'::text, (l.built_at at time zone 'America/New_York')::date, null::time,
         l.company_name, null::text, null::uuid, l.id, l.tenant_id, true
  from rep_leads l, me
  where me.member
    and l.built_at is not null
    and (l.built_at at time zone 'America/New_York')::date between p_from and p_to
    and (me.staff
         or (me.rep_id is not null
             and (l.brought_in_by_rep_id = me.rep_id or l.closed_by_rep_id = me.rep_id)))

  union all
  -- A dealer who paid and went live. Live-mode activations only, so a test
  -- payment never lands on anybody's calendar — the same test rep_dealer_list
  -- makes before it calls a company activated.
  select 'dealer_live'::text, (t.activation_paid_at at time zone 'America/New_York')::date, null::time,
         t.name, null::text, null::uuid, null::uuid, t.id, true
  from tenants t
  left join rep_assignments a on a.tenant_id = t.id and a.effective_to is null
  cross join me
  where me.member
    and t.activation_paid_at is not null
    and t.activation_livemode is true
    and t.closed_at is null
    and (t.activation_paid_at at time zone 'America/New_York')::date between p_from and p_to
    and (me.staff
         or (me.rep_id is not null
             and t.billing_required is true
             and (a.closer_rep_id = me.rep_id or a.onboarder_rep_id = me.rep_id)))

  order by 2, 3 nulls first, 4
$$;

comment on function rep_calendar(date, date) is 'Everything on the calling person''s calendar between two dates: their own follow-ups from rep_followups, plus the milestones derived live from rep_leads and tenants (a lead was added, a lead said yes, a dashboard was built, a dealer went live). Follow-ups are always only your own. Milestones are every company''s for 50. staff and only their own leads and dealers for a rep. Returns nothing for anyone who is not on the 50. tenant. kind is a machine key the caller turns into words.';

commit;
