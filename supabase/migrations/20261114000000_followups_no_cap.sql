-- Invite follow-ups no longer stop after three.
--
-- The reminder was built as a nudge with an end: three sends ever, so a
-- dealer on the default six-month interval reminded a customer at 6, 12 and
-- 18 months and then never again. Joseph's call (Nov 14, 2026): keep sending
-- indefinitely. A customer who bought three years ago is still someone who
-- could recommend the business, and the interval the dealer picked is the
-- whole statement of how often they want to ask.
--
-- The way out stays exactly as it was: every referral email carries an
-- unsubscribe link, anyone who uses it is never emailed again by that
-- company, a closed company's scrubbed addresses are skipped, and a
-- suppressed address shows up in the dealer's monthly summary. Removing the
-- cap removes the ceiling, not the brakes.
--
-- The schedule also changes shape, in api/src/workers/inviteFollowups.js: it
-- used to count from the invite date, which was safe only because three was
-- the most anyone could be owed. Uncapped, that arithmetic would hand a
-- customer invited five years ago on a three-month interval a backlog of
-- twenty overdue reminders and mail them an hour apart. It now counts from
-- their LAST reminder, so everyone gets one every interval from here on and
-- nobody is owed anything for the years before this shipped.

-- Dropped by lookup rather than by name: the original was written inline
-- (`check (sequence between 1 and 3)`) and carries whatever name Postgres
-- generated for it. Dropping a guessed name that does not exist succeeds
-- quietly and would leave the cap in place with everything else here saying
-- it was gone.
do $$
declare
  con_name text;
begin
  for con_name in
    select c.conname
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
     where r.relname = 'invite_followups'
       and n.nspname = 'public'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%sequence%'
  loop
    execute format('alter table public.invite_followups drop constraint %I', con_name);
  end loop;
end $$;

-- Still has to be a real send number: the unique constraint on
-- (customer_id, sequence) is what makes "exactly once per reminder" true, and
-- it only means something if sequence counts up from one.
alter table invite_followups
  add constraint invite_followups_sequence_positive check (sequence >= 1);

-- Fails the migration rather than leaving a half-removed cap behind. If some
-- other CHECK on this table still mentions a literal 3 against sequence, the
-- loop above missed it and the reminders would quietly stop at three while
-- every comment and test here says otherwise.
do $$
declare
  leftover text;
begin
  select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; ')
    into leftover
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where r.relname = 'invite_followups'
     and n.nspname = 'public'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%sequence%'
     and c.conname <> 'invite_followups_sequence_positive';
  if leftover is not null then
    raise exception 'a sequence CHECK survived on invite_followups, so the three-send cap is still live: %', leftover;
  end if;
end $$;

comment on column tenants.invite_followup_months is
  'How often, in months, to send an invited customer their referral link again. 3, 6, 9 or 12; the default is 6. Null means off, which is a deliberate choice rather than the starting state. There is no limit on how many go out: reminders continue at this interval for as long as the customer stays subscribed, counted from their last reminder rather than from their invite. Set by a 50. platform admin on the company''s Pricing screen.';

comment on table invite_followups is
  'One row per follow-up invite claimed for a customer. A sender inserts the claim, sends, then stamps sent_at; a failed send deletes the claim so the next hourly cycle retries, and a claim left unsent for 15 minutes may be re-claimed by anyone. One row per send with no ceiling on the count -- the unique constraint on (customer_id, sequence) is what keeps a given reminder from going twice. Deliberately holds no copy of the address it went to: remove_company scrubs a closed company''s customer emails, and a second copy here would survive that cleanup for no benefit -- which customer and which send is the whole record worth keeping.';
