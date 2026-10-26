-- Six months becomes the standard follow-up interval, rather than off.
--
-- The feature shipped off everywhere so that nothing started sending because
-- it was deployed. That was right then and is wrong now: a dealer who never
-- touches the setting should get the behaviour that makes their program work,
-- not silence. A customer hears about their link once, the day they are
-- invited, and most people forget.
--
-- Six rather than three: a shed or a roof is bought once in a decade or two,
-- and a reminder every quarter about a building somebody already owns reads
-- as nagging. Six months is twice a year for three years, then it stops on
-- its own -- the three-send cap is unchanged.
--
-- SAFE TO APPLY TODAY, and worth saying why rather than hoping. A follow-up
-- is due only once a customer's invite is older than the interval. The oldest
-- invite on this platform is from September 2026, so the first sends under
-- this land in spring 2027. Nothing goes out because this migration ran. The
-- script that applies it checks that claim against the real data first rather
-- than trusting this comment.
begin;

alter table tenants alter column invite_followup_months set default 6;

-- Every dealer whose interval is null. Worth being straight about what that
-- does and does not protect: null is both "never set" and "deliberately
-- turned off", and the column cannot tell them apart, so a dealer who had
-- switched this off WOULD be switched back on here. That is acceptable only
-- because the feature shipped three days ago with nothing enabled and nobody
-- has turned anything off yet. Run this again in six months and it would
-- quietly override real choices -- it is a one-time migration, not a thing to
-- re-run.
--
-- A dealer already on another interval keeps it: that is what `is null`
-- rather than `<> 6` buys. Closed companies are left alone -- remove_company
-- does not clear the interval, and a closed company must not start mailing.
update tenants
   set invite_followup_months = 6
 where invite_followup_months is null
   and closed_at is null;

comment on column tenants.invite_followup_months is
  'How often, in months, to send an invited customer their referral link again. 3, 6, 9 or 12; the default is 6. Null means off, which is now a deliberate choice rather than the starting state. At most three follow-ups ever go out per customer -- see invite_followups -- so 6 means twice a year for three years. Set by a 50. platform admin on the company''s Pricing screen.';

commit;
