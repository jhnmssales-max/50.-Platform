-- Call lists: a bought or built list of companies to ring, worked through by
-- an agency's callers.
--
-- Why this is not just rows in rep_leads. A rep_lead is a company someone has
-- decided is worth pursuing; it carries credit (brought_in_by_rep_id), it
-- feeds the Open pipeline five reps work by hand, and winning one pays
-- somebody. A call list is the opposite end: ten thousand names, most of
-- which will never answer, none of which anyone has formed a view on yet.
-- Pouring those into rep_leads would bury the pipeline the reps actually use
-- and make every lead count meaningless.
--
-- An entry becomes a rep_lead at the moment a human decides it is worth
-- something -- the call where someone says yes, tell me more -- and from then
-- on it is an ordinary lead like any other.
--
-- The other reason to hold the whole list up front, rather than have callers
-- type companies in as they ring them: a company that is only recorded when
-- someone calls it means the ones nobody reached do not exist anywhere. You
-- cannot tell a slow month from a short list, you cannot see coverage, and
-- you cannot tell whether an agency worked 400 names or 4,000.

create table call_lists (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  source_file   text,
  notes         text,
  -- Which rep (or agency, which is a rep row like any other) is working it.
  -- Null means nobody yet; entries are then handed to whoever asks.
  assigned_rep_id uuid references reps(id),
  archived_at   timestamptz,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

comment on table call_lists is 'A list of companies to cold-call, imported from a spreadsheet. Deliberately separate from rep_leads: these are names nobody has formed a view on yet, and mixing ten thousand of them into the pipeline five reps work by hand would bury it. An entry graduates into a rep_lead when a call goes somewhere.';

create table call_list_entries (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references call_lists(id) on delete cascade,
  row_no        int not null,
  company_name  text not null check (length(btrim(company_name)) > 0),
  contact_name  text,
  phone         text,
  email         text,
  website       text,
  city          text,
  state         text,
  notes         text,

  status        text not null default 'waiting'
                  check (status in ('waiting', 'done')),
  outcome       text check (outcome in
                  ('no_answer', 'callback', 'not_interested', 'bad_number', 'interested', 'signed')),
  attempts      int not null default 0 check (attempts >= 0),
  last_called_at timestamptz,
  -- Set by a 'no answer' or a 'call me back Tuesday'. An entry is invisible
  -- to the hand-out until this passes, which is what stops a caller being
  -- given the same unanswered number ten minutes later.
  next_call_after timestamptz,
  last_note     text,

  -- Who currently has it on their screen. Cleared when they record an
  -- outcome, and ignored once stale, so a caller closing their laptop
  -- mid-call does not take a company out of circulation for good.
  claimed_by_rep_id uuid references reps(id),
  claimed_at    timestamptz,

  called_by_rep_id uuid references reps(id),
  -- Set when the entry graduates. From here the company is an ordinary lead.
  rep_lead_id   uuid references rep_leads(id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint call_list_entries_done_has_outcome
    check (status <> 'done' or outcome is not null)
);

comment on table call_list_entries is 'One company on a call list. Handed to one caller at a time (claimed_by_rep_id, with claimed_at going stale after a few minutes so nothing is lost when a browser closes). Recording an outcome either finishes it or sets next_call_after so it comes back round. rep_lead_id is set when a call goes somewhere and the company graduates into the real pipeline.';

comment on column call_list_entries.row_no is 'Its line in the uploaded sheet. Kept so a caller and Joseph can talk about "number 4,312" and mean the same row, and so the list is worked in the order it arrived.';

-- The hand-out query: oldest waiting entry on this list that is not spoken
-- for and not waiting on a callback time. This index is the whole of its
-- performance at 10,000 rows a month.
create index call_list_entries_next_idx
  on call_list_entries (list_id, next_call_after nulls first, row_no)
  where status = 'waiting';

create index call_list_entries_list_idx on call_list_entries (list_id);
create index call_list_entries_claimed_idx on call_list_entries (claimed_by_rep_id) where claimed_by_rep_id is not null;
create index call_list_entries_lead_idx on call_list_entries (rep_lead_id) where rep_lead_id is not null;

-- Import dedupes against these, and the caller screen shows "already on
-- another list" rather than ringing a company twice.
create index call_list_entries_norm_company_idx
  on call_list_entries (fifty_norm_company(company_name));
create index call_list_entries_norm_phone_idx
  on call_list_entries (fifty_norm_digits(phone)) where phone is not null;

-- The same company must not appear twice on one list. Across lists is
-- allowed on purpose: a company that said "not now" in March is a legitimate
-- entry on the autumn list.
create unique index call_list_entries_one_per_list_idx
  on call_list_entries (list_id, fifty_norm_company(company_name));

alter table call_lists enable row level security;
alter table call_list_entries enable row level security;
revoke all on call_lists, call_list_entries from anon, authenticated;
grant select, insert, update, delete on call_lists to authenticated;
grant select, insert, update, delete on call_list_entries to authenticated;

-- Staff see and change everything. A rep sees a list assigned to them, or an
-- unassigned one, and nothing else -- the same shape as rep_leads, where a
-- rep's own rows are all RLS ever hands them.
create policy call_lists_staff_all on call_lists for all to authenticated
  using (is_platform_staff()) with check (is_platform_staff());
create policy call_lists_rep_select on call_lists for select to authenticated
  using (current_rep_id() is not null
         and archived_at is null
         and (assigned_rep_id is null or assigned_rep_id = current_rep_id()));

create policy call_list_entries_staff_all on call_list_entries for all to authenticated
  using (is_platform_staff()) with check (is_platform_staff());
create policy call_list_entries_rep_select on call_list_entries for select to authenticated
  using (exists (select 1 from call_lists l
                  where l.id = list_id
                    and l.archived_at is null
                    and current_rep_id() is not null
                    and (l.assigned_rep_id is null or l.assigned_rep_id = current_rep_id())));
-- A caller may only write to an entry they are holding. Claiming itself goes
-- through claim_next_call(), which is security definer -- so there is no
-- policy here letting a rep claim a row by updating it directly.
-- USING is what proves the row was theirs to begin with. WITH CHECK then
-- only has to stop them handing it to somebody else -- it must allow null,
-- because letting go of the row is how recording a call ends, and a check
-- that demanded they still hold it refused every outcome they tried to save.
create policy call_list_entries_rep_update on call_list_entries for update to authenticated
  using (claimed_by_rep_id is not null and claimed_by_rep_id = current_rep_id())
  with check (claimed_by_rep_id is null or claimed_by_rep_id = current_rep_id());

-- Hand the caller the next company to ring.
--
-- Security definer because claiming is exactly the thing a rep may not do by
-- a plain UPDATE: the row is not theirs until this gives it to them, and the
-- rep policy above only lets them write to a row they already hold.
--
-- `for update skip locked` is what makes two callers on the same list safe.
-- Without it, two people pressing "next" at the same moment read the same
-- row, both claim it, and both ring the same company -- which is the single
-- worst thing a call list can do to a prospect.
create or replace function claim_next_call(p_list_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rep   uuid := current_rep_id();
  v_staff boolean := is_platform_staff();
  v_id    uuid;
begin
  if v_rep is null then
    raise exception 'only a rep can take a call' using errcode = '42501';
  end if;

  if not exists (
    select 1 from call_lists l
     where l.id = p_list_id
       and l.archived_at is null
       and (v_staff or l.assigned_rep_id is null or l.assigned_rep_id = v_rep)
  ) then
    raise exception 'that call list is not yours to work' using errcode = '42501';
  end if;

  -- One caller, one company at a time, even if they double-click.
  --
  -- The "are they already holding one?" check below and the claim beneath it
  -- are two statements. Without this lock, two requests from the same caller
  -- arriving together both find nothing held and both go on to claim -- a
  -- different company each, because SKIP LOCKED makes sure of it. The caller
  -- sees one and the other sits claimed and unrung until its fifteen minutes
  -- run out. SKIP LOCKED was doing its job; the job was the wrong one.
  --
  -- Keyed on the caller and the list together, so two different callers
  -- never wait on each other -- which is the case that has to stay fast.
  perform pg_advisory_xact_lock(hashtextextended(p_list_id::text || ':' || v_rep::text, 0));

  -- Whatever they are already holding comes back first. Reloading the page
  -- mid-call must not skip the company they are talking to.
  select e.id into v_id
    from call_list_entries e
   where e.list_id = p_list_id
     and e.status = 'waiting'
     and e.claimed_by_rep_id = v_rep
     and e.claimed_at > now() - interval '15 minutes'
   order by e.claimed_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  update call_list_entries e
     set claimed_by_rep_id = v_rep,
         claimed_at = now()
   where e.id = (
     select c.id
       from call_list_entries c
      where c.list_id = p_list_id
        and c.status = 'waiting'
        and (c.next_call_after is null or c.next_call_after <= now())
        -- Free, or abandoned by whoever had it. Fifteen minutes is long
        -- enough for a real call and short enough that a closed laptop does
        -- not park a company for the afternoon.
        and (c.claimed_by_rep_id is null or c.claimed_at < now() - interval '15 minutes')
      order by c.next_call_after nulls first, c.row_no
      for update skip locked
      limit 1)
  returning e.id into v_id;

  return v_id;  -- null when the list is finished for now
end $$;

comment on function claim_next_call(uuid) is 'Hands the caller the next company on a list and marks it theirs for fifteen minutes. Returns null when nothing is due -- either the list is worked through, or what is left is waiting on callback times. Uses FOR UPDATE SKIP LOCKED so two callers pressing next at the same moment never get the same company.';

revoke all on function claim_next_call(uuid) from public;
grant execute on function claim_next_call(uuid) to authenticated;

-- What the lists screen shows, and the whole reason for importing the list up
-- front instead of having callers type companies in as they ring them.
create or replace view call_list_progress as
  select l.id,
         l.name,
         l.source_file,
         l.assigned_rep_id,
         l.archived_at,
         l.created_at,
         count(e.*)::int                                                              as total,
         count(e.*) filter (where e.status = 'done')::int                             as done,
         count(e.*) filter (where e.status = 'waiting')::int                          as waiting,
         count(e.*) filter (where e.attempts > 0 and e.status = 'waiting')::int       as in_progress,
         count(e.*) filter (where e.outcome = 'no_answer')::int                       as no_answer,
         count(e.*) filter (where e.outcome = 'callback')::int                        as callback,
         count(e.*) filter (where e.outcome = 'not_interested')::int                  as not_interested,
         count(e.*) filter (where e.outcome = 'bad_number')::int                      as bad_number,
         count(e.*) filter (where e.outcome = 'interested')::int                      as interested,
         count(e.*) filter (where e.outcome = 'signed')::int                           as signed,
         count(e.*) filter (where e.rep_lead_id is not null)::int                     as became_leads,
         sum(e.attempts)::int                                                          as calls_made,
         max(e.last_called_at)                                                         as last_call_at
    from call_lists l
    left join call_list_entries e on e.list_id = l.id
   group by l.id;

comment on view call_list_progress is 'Per-list coverage: how much of it has been worked, what the calls came to, and how many turned into real leads. This is what you cannot have if companies are only entered when somebody rings them -- the ones nobody reached would not exist to count.';

-- Without this the view runs with its owner's rights, so the row-level
-- security on call_lists and call_list_entries never applies to it and every
-- rep sees every list -- including the lists of reps they are not. A view is
-- the one place where RLS is off by default, which is exactly why it is the
-- place it gets missed.
alter view call_list_progress set (security_invoker = true);

grant select on call_list_progress to authenticated;
