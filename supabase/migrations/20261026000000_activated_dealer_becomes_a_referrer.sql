-- ---------------------------------------------------------------------------
-- A dealer who activates becomes a referrer for 50. itself.
--
-- 50. runs its own referral program on its own platform: the 50. tenant
-- (slug '50-platform') has customers and invite links like any other
-- tenant, and its "customers" are the dealers paying to use it. When a
-- dealer's activation fee clears, each of that dealer's admins becomes a
-- customer of the 50. tenant, with their own invite link, and is invited
-- exactly the way a shed buyer is invited by their dealer. They see the
-- product from the receiving end, and they can pass 50. on.
--
-- This column is how that stays a one-time event. It records which dealer
-- tenant's activation minted this customers row -- not the tenant the row
-- belongs to, which is always 50.'s. Paired with the admin's email it is
-- the claim: one row per admin per activated dealer, however many times
-- Stripe redelivers the event or an admin is added and removed.
--
-- A plain unique index (not a partial one) for the same reason
-- customers_source_referral_id_idx is plain: `ON CONFLICT (a, b)` needs a
-- real unique constraint to name as its arbiter, and a partial index
-- cannot be one. Rows with a null source_activated_tenant_id -- every
-- customer a dealer ever typed in, and every converted friend -- do not
-- conflict with each other, because null is never equal to null.
-- ---------------------------------------------------------------------------
alter table customers add column source_activated_tenant_id uuid references tenants(id);

create unique index customers_source_activated_tenant_idx
  on customers (source_activated_tenant_id, email);

comment on column customers.source_activated_tenant_id is
  'The dealer tenant whose activation auto-created this customers row in the 50. tenant (one row per admin of that dealer, so each can refer 50. on). Null for every other customer, including a dealer-entered one and a converted friend (see source_referral_id). Claimed via INSERT ... ON CONFLICT (source_activated_tenant_id, email) DO NOTHING by routes/webhooks.js on activation -- that pair, not an email match, is how "has this dealer admin already been set up as a referrer for 50.?" is decided.';
