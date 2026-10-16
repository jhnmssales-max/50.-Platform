-- Follow-ups a rep sets for themselves, and the calendar that shows them
-- alongside what already happened.
--
-- Wrapped in one explicit transaction like the other migrations in this
-- project: either all of it lands or none of it does.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. The reps page calls
-- rep_calendar() to draw the Calendar tab and the reminder worker
-- (workers/followupReminders.js) selects from rep_followups every hour; code
-- that reaches production before they exist breaks the tab and logs an error
-- each cycle.
--
-- WHY THE OWNER IS A LOGIN AND NOT A REP
-- current_rep_id() is deliberately null for Joseph (see the rep_pipeline
-- migration: "admin is Joseph"), so keying a follow-up on reps.id would give
-- the one person who closes most of the business no calendar at all. Every
-- person who can open the reps area has a users row — admin, staff and rep
-- alike — so that is what a follow-up belongs to. It also means a rep who is
-- later promoted, or an admin who is also given a rep row, keeps their list.
--
-- WHAT IS STORED AND WHAT IS DERIVED
-- Only the follow-ups are stored. The milestones on the calendar (a lead said
-- yes, a dashboard was built, a dealer went live) are read live from the rows
-- that already record them. Storing copies would mean keeping two records in
-- step forever, and a company removed by remove_company() would leave
-- calendar entries behind pointing at nothing.
begin;

-- ---------------------------------------------------------------------------
-- rep_followups — "call Dave back Tuesday"
-- ---------------------------------------------------------------------------
create table rep_followups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  due_on      date not null,
  due_time    time,
  title       text not null check (length(btrim(title)) > 0 and length(title) <= 200),
  note        text check (note is null or length(note) <= 2000),
  lead_id     uuid references rep_leads(id) on delete set null,
  tenant_id   uuid references tenants(id) on delete set null,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- The worker sweeps by date across every user; the page reads one user's month.
create index rep_followups_due_idx on rep_followups (due_on) where done_at is null;
create index rep_followups_user_due_idx on rep_followups (user_id, due_on);

comment on table rep_followups is 'A reminder someone set for themselves on the reps page — the only part of the calendar that is stored. Belongs to a users row, not a reps row, so the admin (who is not a rep) has a calendar too. Milestones shown next to these are derived live by rep_calendar(); nothing copies them here.';
comment on column rep_followups.user_id is 'Whose follow-up it is. Cascades: removing a rep deletes their login (remove_rep) and with it their follow-ups, which are personal notes and are not part of the money history that remove_rep preserves.';
comment on column rep_followups.due_time is 'Optional time of day. Null means an all-day item, which is how most of these are set — the reminder email is a morning digest either way, and the time is shown to the person so they know when they meant to call.';
comment on column rep_followups.lead_id is 'The lead this is about, if it was set from a lead row. Set to null rather than cascading if the lead ever goes, so the person keeps the note they typed.';
comment on column rep_followups.tenant_id is 'The dealer this is about, if it was set from a company row. Set to null if the company is deleted by remove_company(), for the same reason as lead_id — the title still carries the name they typed.';
comment on column rep_followups.done_at is 'When they ticked it off. Null means still outstanding, which is what the reminder email counts and what makes an item overdue once its date has passed.';

alter table rep_followups enable row level security;
revoke all on rep_followups from anon, authenticated;
grant select, insert, update, delete on rep_followups to authenticated;

-- Your own, and only your own — including for Joseph, who asked for exactly
-- this. is_platform_member() is belt-and-braces on top of the uid match: it
-- keeps the table to the 50. tenant, so a dealer's signed-in staff can never
-- put a row in it even though they have a uid of their own.
create policy rep_followups_own_select on rep_followups
  for select to authenticated using (user_id = auth.uid() and is_platform_member());
create policy rep_followups_own_insert on rep_followups
  for insert to authenticated with check (user_id = auth.uid() and is_platform_member());
create policy rep_followups_own_update on rep_followups
  for update to authenticated
  using (user_id = auth.uid() and is_platform_member())
  with check (user_id = auth.uid() and is_platform_member());
create policy rep_followups_own_delete on rep_followups
  for delete to authenticated using (user_id = auth.uid() and is_platform_member());
-- ---------------------------------------------------------------------------
-- rep_reminder_emails — the "has today's digest gone out?" record
-- ---------------------------------------------------------------------------
-- One row per (user, day), which is what makes the morning email arrive once
-- however many times the hourly worker runs, across restarts and across two
-- instances. Same claim / send / stamp dance as billing_emails: a sender
-- inserts the row (claimed_at = now()), sends, then stamps sent_at. A failed
-- send deletes its claim so the next hour tries again; a sender that dies
-- mid-send leaves an unsent claim anyone may take again once it is 15 minutes
-- old.
create table rep_reminder_emails (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  for_date    date not null,
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  recipients  text,
  detail      jsonb,
  created_at  timestamptz not null default now(),
  constraint rep_reminder_emails_one_per_day unique (user_id, for_date)
);

comment on table rep_reminder_emails is 'Ledger of the morning follow-up digest sent to each person on the reps page. The unique (user_id, for_date) is what makes it go out once a day. Written only by the service role (workers/followupReminders.js).';
comment on column rep_reminder_emails.for_date is 'The day the digest covered, in America/New_York — the same zone the billing periods use, so "today" means the same thing everywhere in this system.';
comment on column rep_reminder_emails.claimed_at is 'When a sender took this row. An unsent claim older than 15 minutes (a crashed sender) may be taken again; a failed send deletes its claim outright.';
comment on column rep_reminder_emails.recipients is 'The address the digest was sent to, as it was at the time. Kept because a login''s email can change afterwards, and "where did it actually go?" then has no other answer.';
comment on column rep_reminder_emails.detail is 'Which follow-ups the digest listed, split into today and overdue, for answering "what did we send them?" later. Not read back by the worker.';

-- Service role only, like billing_emails: RLS on with no policy at all.
alter table rep_reminder_emails enable row level security;

-- ---------------------------------------------------------------------------
-- rep_calendar() — one list of everything on your calendar in a date range
-- ---------------------------------------------------------------------------
-- security definer because the milestones come from tenants, which a rep
-- cannot read directly (tenants_select_own shows a signed-in user only their
-- OWN tenant — for a rep that is the 50. tenant, not their dealers). So the
-- scoping is written out here rather than left to RLS, exactly as
-- rep_dealer_list() does it, and every branch is gated on being a 50. member.
--
-- Who sees which milestones:
--   50. staff/admin  -- every company's, because they run the business and
--                       asked to see when a rep signs somebody up
--   a rep            -- only leads they brought in or closed, and only
--                       dealers they are the closer or onboarder on
--                       (the same test rep_leads' own RLS policy makes)
--   anyone else      -- nothing
--
-- Follow-ups are never shared: always and only your own, whoever you are.
--
-- kind is a machine key, not a sentence. The page and the email turn it into
-- words, so changing the wording never needs a migration.
--   'followup'      title = what they typed,   detail = their note
--   'lead_won'      title = the company name,  detail = null
--   'dealer_built'  title = the company name,  detail = null
--   'dealer_live'   title = the company name,  detail = null
create function rep_calendar(p_from date, p_to date) returns table (
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

revoke all on function rep_calendar(date, date) from public, anon;
grant execute on function rep_calendar(date, date) to authenticated;

comment on function rep_calendar(date, date) is 'Everything on the calling person''s calendar between two dates: their own follow-ups from rep_followups, plus the milestones derived live from rep_leads and tenants (a lead said yes, a dashboard was built, a dealer went live). Follow-ups are always only your own. Milestones are every company''s for 50. staff and only their own leads and dealers for a rep. Returns nothing for anyone who is not on the 50. tenant. kind is a machine key the caller turns into words.';

commit;
