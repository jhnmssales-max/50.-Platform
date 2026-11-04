-- When a customer was last sent their referral link.
--
-- Joseph: dealers need to see who they have already sent to, and when. The
-- dashboard could not answer that at all before this -- there was a POST to
-- add a customer and no GET to list them.
--
-- "When did we last send to this person" could almost be derived: the first
-- invite goes out as the customer row is created, and the automatic
-- follow-ups stamp invite_followups.sent_at. Almost, because of the one case
-- that matters most to a dealer standing in front of a customer: adding an
-- address already on the list RE-SENDS that person's existing link (see
-- POST /customers) and records nothing at all. A dealer who resent Bob's link
-- this morning would be shown a date from March.
--
-- So it is stored rather than derived. Stamped on create and on every resend,
-- which makes it the one honest answer to "when did this last go out".
begin;

alter table customers add column last_invited_at timestamptz;

-- Backfill to the best record we have for rows that predate the column: the
-- most recent follow-up if one was sent, otherwise the day the row was made
-- (which is when the first invite went out). Manual resends before today are
-- unrecoverable -- they were never written down -- so those rows read as the
-- original send, which is the truth as far as the system ever knew it.
update customers c
   set last_invited_at = greatest(
         c.created_at,
         coalesce((select max(f.sent_at) from invite_followups f where f.customer_id = c.id), c.created_at)
       );

alter table customers alter column last_invited_at set default now();

-- The list is read per tenant, newest send first, so that is the index.
create index customers_tenant_last_invited_idx on customers (tenant_id, last_invited_at desc);

comment on column customers.last_invited_at is
  'When this customer was last sent their referral link -- the first invite, an automatic follow-up, or a manual resend from the dashboard. Stored rather than derived because a manual resend (adding an address already on the list) sends the existing link and leaves no other trace. Backfilled from created_at and invite_followups.sent_at for rows created before the column existed.';

commit;
