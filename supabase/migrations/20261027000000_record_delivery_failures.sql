-- Remembering that an address could not be delivered to.
--
-- Thirteen addresses on this platform are suppressed at Postmark: they
-- bounced once, and Postmark will now silently refuse every future send to
-- them. Nothing in 50. knows that. A dealer presses send, the dashboard says
-- sent, and the customer never hears anything -- which is how two of Silver
-- Run's customers have been sitting in a referral program they can never
-- take part in.
--
-- Postmark already tells us, at the moment it happens: a send to a suppressed
-- address comes back with a non-zero ErrorCode (406, inactive recipient)
-- rather than silence. lib/postmark.js already turns that into a throw. This
-- is where that fact gets kept instead of being logged and lost.
--
-- Deliberately not a bounce webhook. A webhook would also catch the first
-- bounce of an address that was fine until today, which is better -- but it
-- is a public endpoint, a signature to verify and a new failure mode, and
-- this gets most of the value from something that already happens.
begin;

alter table customers add column delivery_failed_at timestamptz;
alter table customers add column delivery_error text;

comment on column customers.delivery_failed_at is
  'When a referral email to this customer was last refused by the mail provider -- almost always a suppressed address, meaning it bounced at some point and nothing will be delivered to it again. Cleared the moment a send to them succeeds, so it always describes the latest attempt rather than a scar. Null means every attempt so far has gone through, or none has been made.';
comment on column customers.delivery_error is
  'What the mail provider said, kept short and shown to the dealer in their monthly summary so "this address does not work" is actionable rather than mysterious. Null whenever delivery_failed_at is null.';

-- A fourth kind of monthly email, and the only one every dealer gets.
--
-- referral_statement is a bill: it goes to a dealer who owes something, and
-- a dealer with no referrals that month hears nothing. That is correct for a
-- bill and useless as a report. monthly_activity is the other half -- who was
-- invited, and which of them cannot be reached -- and it goes to in-house
-- companies too, which have no bill and so have never had a monthly email at
-- all.
--
-- Same (tenant, kind, period) claim as the others, so it still goes out
-- exactly once per dealer per month however often the worker runs.
alter table billing_emails drop constraint billing_emails_kind_check;
alter table billing_emails add constraint billing_emails_kind_check
  check (kind in ('activation_receipt', 'referral_statement', 'annual_summary', 'monthly_activity'));

commit;
