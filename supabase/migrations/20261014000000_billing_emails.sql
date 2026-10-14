-- Wrapped in one explicit transaction, like the other billing migrations:
-- either all of it lands or none of it does.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. The billing-email
-- worker (workers/billingEmails.js) selects from billing_emails and from
-- billing_events.statement_period every hour; code that reaches production
-- before they exist logs an error each cycle (it never touches a charge).
begin;

-- The emails 50. sends a dealer about money: a receipt after the activation
-- payment, one summary a month when referral fees were charged, and one
-- summary a year. (The yearly-fee notice/receipt/failed emails are sent by
-- workers/annualRenewal.js and are not part of this table.)
--
-- One row per (tenant, kind, period) is the whole "has this been sent?"
-- record, enforced by the database rather than by whichever process happens
-- to run:
--   kind 'activation_receipt'  period 'activation'
--   kind 'referral_statement'  period 'YYYY-MM'  (the month being summarized)
--   kind 'annual_summary'      period 'YYYY'     (the calendar year)
-- A sender first CLAIMS its row (insert; claimed_at = now()), sends, then
-- stamps sent_at. A failed send deletes the claim so the next hourly run
-- tries again; a process that dies mid-send leaves an unsent claim that
-- anyone may re-claim once it is 15 minutes old. Two overlapping runs, two
-- servers, or a webhook racing the hourly sweep can therefore never both
-- send the same email.
create table billing_emails (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null
                check (kind in ('activation_receipt', 'referral_statement', 'annual_summary')),
  period      text not null,
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  recipients  text,
  detail      jsonb,
  created_at  timestamptz not null default now(),
  constraint billing_emails_one_per_period unique (tenant_id, kind, period)
);

create index billing_emails_tenant_id_idx on billing_emails (tenant_id);

comment on table billing_emails is 'Ledger of the receipt/summary emails 50. sends a billing-required dealer (activation receipt, monthly referral-fee summary, yearly summary). The unique (tenant_id, kind, period) is what makes each go out exactly once. Written only by the service role (workers/billingEmails.js).';
comment on column billing_emails.period is '''activation'' for the activation receipt; ''YYYY-MM'' for a monthly referral summary (the month it summarizes, America/New_York); ''YYYY'' for a yearly summary (the calendar year, America/New_York).';
comment on column billing_emails.claimed_at is 'When a sender took this row. An unsent claim older than 15 minutes (a crashed sender) may be taken again; a failed send deletes its claim outright.';
comment on column billing_emails.sent_at is 'When the email was accepted by Postmark. Null while claimed but not yet sent.';
comment on column billing_emails.detail is 'What the email covered (billing_event ids, totals) — for answering "what did we tell them?" later. Not read back by the worker.';

-- Service role only, like every other table the Stripe webhook and workers
-- write: RLS on with no policy, so the authenticated role (a dealer's
-- signed-in staff) can neither read nor write it.
alter table billing_emails enable row level security;

-- Which monthly summary a charged referral fee was reported in. Null until
-- reported. This is what makes a fee that confirms late (a bank debit that
-- clears days after it was attempted) show up in the next summary instead of
-- being missed: each summary lists every succeeded, not-yet-reported fee.
alter table billing_events
  add column statement_period text;

alter table billing_events
  add constraint billing_events_statement_period_shape
    check (statement_period is null or (event_type = 'referral_fee' and statement_period ~ '^[0-9]{4}-[0-9]{2}$'));

comment on column billing_events.statement_period is 'For a succeeded referral_fee row: the ''YYYY-MM'' of the monthly summary email that listed it (billing_emails kind referral_statement). Null until it has been listed. Written only by workers/billingEmails.js.';

-- The monthly summary's "succeeded fees not reported yet, for this tenant"
-- lookup — small, partial, and empty once everything has been reported.
create index billing_events_unreported_fees_idx
  on billing_events (tenant_id, created_at)
  where event_type = 'referral_fee' and status = 'succeeded' and statement_period is null;

commit;
