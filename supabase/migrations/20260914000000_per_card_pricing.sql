begin;

-- Billing model refinement: express pricing per CARD, not per referral,
-- for the dealer-facing number — without changing what actually gets
-- charged or issued. per_referral_charge_cents already equals
-- reward_amount_cents * 2 + platform_fee_cents (one card for the
-- referrer, one for the new customer, plus the platform's fee); that is
-- algebraically identical to (reward_amount_cents + platform_fee_cents / 2)
-- * 2 — i.e. a single "per card" rate, doubled. per_card_rate_cents below
-- is exactly that per-card rate, added as its own column so the API can
-- hand a dealer "2 cards x $99.50 = $199.00" instead of a single lump
-- sum with no visible breakdown.
--
-- Deliberately NOT built as a column per_referral_charge_cents is
-- generated *from* (per_card_rate_cents * 2): Postgres does not allow a
-- generated column's expression to reference another generated column
-- ("generation expression can refer to other columns, but not other
-- generated columns") — confirmed against the Postgres docs before
-- attempting it, not discovered by a failed migration this time. Instead
-- both per_card_rate_cents and per_referral_charge_cents are generated
-- independently from the same two base columns (reward_amount_cents,
-- platform_fee_cents), so they can never drift apart, and
-- per_referral_charge_cents itself needs no ALTER at all — its existing
-- generation expression already equals per_card_rate_cents * 2, just
-- expressed in terms of the same underlying inputs rather than
-- referencing the new column directly.
--
-- The even-cents constraint on platform_fee_cents is what makes that
-- equality exact rather than off by a stray half-cent: integer division
-- in Postgres truncates, so an odd platform_fee_cents would make
-- per_card_rate_cents * 2 come out one cent short of
-- per_referral_charge_cents. Nothing today sets an odd value (the
-- default, 9900, and the $39 floor, 3900, both are), so this only
-- forecloses a possibility that was never actually used, not a
-- real behavior change for any existing tenant.
alter table tenants
  add constraint tenants_platform_fee_cents_even check (platform_fee_cents % 2 = 0);

alter table tenants
  add column per_card_rate_cents integer
    generated always as (reward_amount_cents + platform_fee_cents / 2) stored;

comment on column tenants.per_card_rate_cents is 'The dealer-facing per-card rate: reward_amount_cents + half of platform_fee_cents. Two cards are issued per referral (referrer + new customer), so per_referral_charge_cents == per_card_rate_cents * 2 always (see this migration''s own comment for why that''s an algebraic identity between two independently-generated columns, not a literal column reference). Exists so the API and dealer-facing UI can express pricing as "cards issued x rate" instead of one undifferentiated per-referral total.';

commit;
