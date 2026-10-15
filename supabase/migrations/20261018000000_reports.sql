-- Reports: what each rep has actually done, and what the platform makes and
-- spends. Everything a number here is built from already exists — leads,
-- assignments, billing_events, rep_earnings — except two things this adds,
-- because they cannot be derived from anything:
--
--   1. What it COSTS to run the platform. Nothing in the database knows what
--      Render or Postmark bills, so there is a table to put it in.
--   2. How many leads were LOST. Losing a lead deletes it (see the previous
--      migration), which is right for the contact's details and wrong for the
--      arithmetic: without a count, a conversion rate has no denominator. So a
--      bare tally survives the delete — a rep, a month, a number. No company
--      name, no contact, nothing about who it was.
--
-- One explicit transaction. Safe to apply before the API code that reads it.
begin;

-- ---------------------------------------------------------------------------
-- 1. The tally that outlives a deleted lead
-- ---------------------------------------------------------------------------
create table rep_lead_outcomes (
  rep_id      uuid not null references reps(id) on delete cascade,
  month       text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  lost_count  integer not null default 0 check (lost_count >= 0),
  updated_at  timestamptz not null default now(),
  primary key (rep_id, month)
);

comment on table rep_lead_outcomes is 'How many leads each rep lost, by month. Deliberately nothing but a count: losing a lead deletes it, and this exists only so a conversion rate has a denominator. A lead with no rep on it is not counted — there is nobody to count it for.';

alter table rep_lead_outcomes enable row level security;
revoke all on rep_lead_outcomes from anon, authenticated;
grant select on rep_lead_outcomes to authenticated;
-- Written only by the service role, from the delete route. Read by staff for
-- everyone, and by a rep for themselves.
create policy rep_lead_outcomes_staff_select on rep_lead_outcomes
  for select to authenticated using (is_platform_staff());
create policy rep_lead_outcomes_own_select on rep_lead_outcomes
  for select to authenticated using (rep_id = current_rep_id());

-- ---------------------------------------------------------------------------
-- 2. What it costs to run the platform
-- ---------------------------------------------------------------------------
-- Rows are seeded below with the real services this runs on and amounts of
-- ZERO, because nothing here can know what any of them actually bills. The
-- list is the useful part — what it takes to run this — and the numbers are
-- Joseph's to fill in.
create table platform_expenses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  category      text not null default 'other'
                  check (category in ('hosting', 'email', 'payments', 'software', 'rewards', 'people', 'other')),
  amount_cents  integer not null default 0 check (amount_cents >= 0),
  -- 'monthly' and 'yearly' spread across the months they cover; 'once' lands
  -- wholly in the month of started_on.
  recurrence    text not null default 'monthly' check (recurrence in ('monthly', 'yearly', 'once')),
  started_on    date not null default current_date,
  ended_on      date,
  notes         text,
  created_at    timestamptz not null default now(),
  constraint platform_expenses_ends_after_start check (ended_on is null or ended_on >= started_on)
);

create index platform_expenses_period_idx on platform_expenses (started_on, ended_on);

comment on table platform_expenses is 'What running 50. costs. Monthly and yearly rows spread over the months they cover; a one-off lands in its own month. An ended_on closes a cost out without losing the history of the months it did apply to.';

alter table platform_expenses enable row level security;
revoke all on platform_expenses from anon, authenticated;
grant select, insert, update, delete on platform_expenses to authenticated;
-- Money: the 50. admin only, like every other money table here.
create policy platform_expenses_admin_select on platform_expenses
  for select to authenticated using (is_platform_admin());
create policy platform_expenses_admin_insert on platform_expenses
  for insert to authenticated with check (is_platform_admin());
create policy platform_expenses_admin_update on platform_expenses
  for update to authenticated using (is_platform_admin()) with check (is_platform_admin());
create policy platform_expenses_admin_delete on platform_expenses
  for delete to authenticated using (is_platform_admin());

-- The services this actually runs on, at zero, for Joseph to price. Naming
-- them is something this migration can honestly do; guessing what they bill
-- is not, and a made-up number in a profit figure is worse than a blank one.
insert into platform_expenses (name, category, amount_cents, recurrence, notes) values
  ('Render — web service',        'hosting',  0, 'monthly', 'The API. Set this to what Render bills.'),
  ('Render — static site',        'hosting',  0, 'monthly', 'go.referwith50.com.'),
  ('Supabase',                    'hosting',  0, 'monthly', 'Database, sign-ins and file storage.'),
  ('Postmark',                    'email',    0, 'monthly', 'Every email the platform sends.'),
  ('Domain — referwith50.com',    'software', 0, 'yearly',  'Renewal.'),
  ('Google Workspace',            'software', 0, 'monthly', 'joseph@referwith50.com.'),
  ('Gift card provider',          'rewards',  0, 'monthly', 'Any account or per-card fee on top of the cards themselves.');

-- ---------------------------------------------------------------------------
-- 3. The one cost that is a percentage, not a bill
-- ---------------------------------------------------------------------------
-- Card processing comes off every payment taken, so it cannot sit in the table
-- above as a flat amount. Stripe's standard US rate is the default; it is a
-- setting because it is not ours to assume, and the reports label it an
-- estimate rather than pretending it is a receipt.
create table platform_finance_settings (
  id                      boolean primary key default true check (id),
  card_fee_bps            integer not null default 290 check (card_fee_bps >= 0 and card_fee_bps <= 10000),
  card_fee_fixed_cents    integer not null default 30 check (card_fee_fixed_cents >= 0),
  updated_at              timestamptz not null default now()
);

insert into platform_finance_settings default values;

comment on table platform_finance_settings is 'The processing cost that comes off each payment taken, as a rate rather than a bill. Defaults to Stripe''s standard US card rate (2.9% + 30c). The reports call what this produces an estimate, because that is what it is.';

alter table platform_finance_settings enable row level security;
revoke all on platform_finance_settings from anon, authenticated;
grant select, update on platform_finance_settings to authenticated;
create policy platform_finance_admin_select on platform_finance_settings
  for select to authenticated using (is_platform_admin());
create policy platform_finance_admin_update on platform_finance_settings
  for update to authenticated using (is_platform_admin()) with check (is_platform_admin());

commit;
