-- ---------------------------------------------------------------------------
-- The Monday morning email: how last week went, one line per rep.
--
-- Joseph has had no weekly view of the pipeline at all. Everything the reps
-- page knows is a number you have to go and look at, which means it is a
-- number nobody looks at until something has already gone quiet. Handing the
-- building of dealers to an agency makes that worse, not better: the whole
-- point is that he stops being in the loop, and a loop he is out of needs to
-- report itself.
--
-- Its own ledger rather than a row in rep_reminder_emails, because that
-- table's unique key is (user_id, for_date) and Joseph gets the daily digest
-- too. Both on the same Monday would be the same key.
begin;

create table rep_week_report_emails (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  week_start  date not null,
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  recipients  text,
  detail      jsonb,
  created_at  timestamptz not null default now(),
  constraint rep_week_report_emails_one_per_week unique (user_id, week_start)
);

comment on table rep_week_report_emails is 'Ledger of the Monday status report. The unique (user_id, week_start) is what makes it go out once a week — the worker runs on the same hourly tick as everything else, so the other 160-odd ticks find this row already there and do nothing. Written only by the service role (workers/weeklyStatusReport.js).';
comment on column rep_week_report_emails.week_start is 'The MONDAY of the week the report covered, in America/New_York — the same zone the billing periods and the daily digest use, so a week means the same thing everywhere in this system.';
comment on column rep_week_report_emails.claimed_at is 'When a sender took this row. An unsent claim older than 15 minutes (a crashed sender) may be taken again; a failed send deletes its claim outright.';
comment on column rep_week_report_emails.recipients is 'The address the report was sent to, as it was at the time. A login''s email can change afterwards, and "where did it actually go?" then has no other answer.';
comment on column rep_week_report_emails.detail is 'The figures the report quoted, so a later question about a number has the number it was actually sent. Not read back by the worker.';

-- Service role only, like rep_reminder_emails and billing_emails: RLS on with
-- no policy at all, so a signed-in session of any role reads nothing here.
alter table rep_week_report_emails enable row level security;

commit;
