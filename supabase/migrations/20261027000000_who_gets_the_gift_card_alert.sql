-- ---------------------------------------------------------------------------
-- Who, at a dealer, is told that gift cards need to go out.
--
-- Until now the "referral marked paid -- send gift cards" alert went to
-- whoever entered that customer, copying every other login on the account.
-- Every login a dealer has is created as an admin (routes/reps.js is the
-- only thing that makes them, and it always does), so in practice that
-- meant everyone who can sign in heard about every referral.
--
-- That is the right default when nobody has said otherwise, and it stays
-- the default. But a dealer with a manager and a salesperson often wants
-- one of them handling the cards and the other left alone. This flag is
-- how Joseph says which: tick the people who should be told, and only they
-- are. Tick nobody and the old rule applies unchanged, which is why every
-- dealer already on the platform keeps behaving exactly as it does today.
--
-- Deliberately on users and not on tenants: the question is about people,
-- the answer changes when a person leaves, and a flag living on the login
-- goes with them. There is no separate table to tidy up afterwards.
--
-- This does not decide WHETHER the dealer sends the cards at all --
-- tenants.reward_fulfillment does that, and when it says 'platform' the
-- alert goes to 50. instead and no tick on this table is consulted.
-- ---------------------------------------------------------------------------
alter table users add column gets_reward_alerts boolean not null default false;

comment on column users.gets_reward_alerts is
  'True if this login should receive the "a referral was marked paid, send the gift cards" alert. When no login on a tenant has it set, the alert falls back to its original rule: addressed to whoever entered that customer, copying every other login. Ignored entirely when the tenant''s reward_fulfillment is ''platform'', because then 50. sends the cards and 50. is told, not the dealer. Set only by a 50. platform admin, from Companies -> Logins.';

-- Reading it means asking "who on this tenant is ticked", so index the pair
-- rather than the flag alone.
create index users_reward_alert_recipients_idx
  on users (tenant_id) where gets_reward_alerts;
