begin;

-- Stage 4 of Stripe billing: the reward-issuance worker itself. No new
-- billing_events/tenants/referrals columns needed — Stage 1's schema
-- already anticipated this worker directly (per_referral_charge_cents'
-- own comment: "one $X reward for the referrer, one for the new
-- customer"; billing_events.status already includes 'needs_refund';
-- referrals.reward_eligible_at/reward_issued_at and
-- referrals_reward_eligible_idx already exist to serve exactly this
-- worker's candidate query). The one real gap is this: issuing a reward
-- to the *referred friend* (gift_card_transactions.recipient_role =
-- 'new_customer') requires a customers row for them, and nothing in this
-- schema ever created one — customers.comment already says a referred
-- friend gets "auto-created at that point so they can refer their own
-- friends," but "at that point" was never wired to any actual code until
-- now.
--
-- source_referral_id is that wiring: the one referral whose conversion
-- caused this customer row to be auto-created, if any (null for a
-- customer a dealer entered directly via POST /api/customers). The
-- unique index makes "find or create the friend's customer row" a true
-- one-time claim — INSERT ... ON CONFLICT (source_referral_id) DO
-- NOTHING, the same idempotency-via-unique-constraint pattern every other
-- claim in this schema already uses — rather than a heuristic match on
-- email, which could silently merge a referred friend into an unrelated
-- customer row a dealer happened to create with the same address.
--
-- Not a partial index (confirmed live): ON CONFLICT's arbiter inference
-- requires an index whose predicate it can match exactly, and a bare
-- `ON CONFLICT (source_referral_id)` does not carry one. A plain unique
-- index needs no predicate anyway — NULL is never considered equal to
-- another NULL for uniqueness purposes, so every dealer-entered customer
-- (source_referral_id null) coexists freely; only two rows both claiming
-- the *same* real referral id would ever conflict, which is exactly the
-- one case this must prevent.
alter table customers add column source_referral_id uuid references referrals(id);

create unique index customers_source_referral_id_idx on customers (source_referral_id);

comment on column customers.source_referral_id is 'The referral whose conversion auto-created this customer row (the referred friend becoming a customer in their own right), if any. Null for a customer a dealer entered directly. Claimed via INSERT ... ON CONFLICT (source_referral_id) DO NOTHING by the reward-issuance worker (workers/rewardIssuance.js) — see that file for why this, not an email match, is how "does this friend already have a customer row" is decided.';

commit;
