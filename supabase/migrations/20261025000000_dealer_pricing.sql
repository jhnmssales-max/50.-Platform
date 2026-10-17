-- Per-dealer pricing, and who actually sends the gift cards.
--
-- WHAT CHANGES, AND WHY
--
-- The usage fee was a percentage (referral_fee_bps, 30%) of the total payout
-- -- both cards -- so a $50/$50 program was charged $30. That breaks for the
-- dealers who buy and send their own gift cards: 50. never fronts those cards,
-- so there is nothing to take a percentage OF. Set their reward to $0 to
-- reflect that 50. isn't paying for cards and the fee collapses to 30% of
-- nothing. The fee is now a flat amount per rewarded referral
-- (referral_fee_cents), which is the same money for today's dealers and
-- survives a dealer whose cards 50. never touches.
--
-- referral_fee_bps is deliberately LEFT IN PLACE. billing_events.fee_rate_bps
-- records the rate each historical charge was computed at, and dropping the
-- column it came from would orphan that history. Nothing new reads it.
--
-- WHY A NEW COLUMN AND NOT tenants.platform_fee_cents
--
-- platform_fee_cents already looks like this: a flat per-referral fee,
-- defaulting to $99. It belongs to the OTHER billing path -- the Stage 4
-- reward-issuance worker, which charges per_referral_charge_cents (a
-- generated column: reward_amount_cents * 2 + platform_fee_cents) and buys
-- the gift cards itself. That worker refuses to run unless
-- GIFT_CARD_PROVIDER names a real provider, and it is 'stub' today, so it
-- charges nobody; every live charge goes through routes/referrals.js ->
-- lib/referralFee.js instead.
--
-- Reusing platform_fee_cents would mean editing an input to a stored
-- generated column that a dormant worker still reads, so the day a gift-card
-- provider is finally connected that worker would wake up charging amounts
-- someone set for a different purpose. It also carries a >= $39 floor, and
-- these fees need to go lower than that. Hence a separate column for the
-- path that actually runs.
--
-- NOBODY'S BILL CHANGES. referral_fee_cents is backfilled from each tenant's
-- own existing rate and reward, so every dealer already running keeps paying
-- exactly what they paid yesterday. The default for a tenant with no reward
-- set is $30, which is 30% of the standard $50/$50 program.

alter table tenants
  -- The flat fee charged when a referral is marked rewarded. 0 is allowed:
  -- an in-house or free dealer is a real case, and billing_exempt already
  -- skips the charge entirely anyway.
  add column referral_fee_cents integer not null default 3000
    check (referral_fee_cents >= 0),

  -- Who puts the gift cards in the customer's hands.
  --   'dealer'   -- 50. emails the dealer, the dealer sends the cards
  --               (or mails physical ones) whenever it suits them.
  --   'platform' -- 50. emails the cards straight to the customer and the
  --               friend when the dealer marks the referral paid.
  -- Defaults to 'dealer' because that is how every tenant works today:
  -- Good Steward's cards are bought and sent by hand.
  add column reward_fulfillment text not null default 'dealer'
    check (reward_fulfillment in ('dealer', 'platform')),

  -- Whether the dealer's card is also charged the face value of the gift
  -- cards on top of the fee. Separate from reward_fulfillment on purpose:
  -- who sends a card and who pays for it are two different questions, and
  -- Joseph sets them per dealer. False everywhere today -- no tenant is
  -- currently charged for cards 50. did not buy.
  add column charge_card_cost boolean not null default false;

-- Each tenant's own historical rate against its own reward, so the flat
-- amount lands on exactly the number its percentage produced. Both inputs
-- are NOT NULL, so this covers every tenant -- no row is left on the bare
-- default and no row is silently backfilled to zero.
update tenants
   set referral_fee_cents = round((reward_amount_cents * 2 * referral_fee_bps)::numeric / 10000)::integer;

comment on column tenants.referral_fee_cents is
  'Flat fee charged to this dealer each time a referral is marked rewarded. Replaced the referral_fee_bps percentage, which could not bill a dealer whose gift cards 50. never buys. See api/src/lib/referralFee.js.';
comment on column tenants.reward_fulfillment is
  '''platform'' = 50. emails the gift cards to the customer and friend; ''dealer'' = 50. emails the dealer and they send them. Does not by itself decide who PAYS for the cards -- that is charge_card_cost.';
comment on column tenants.charge_card_cost is
  'When true, this dealer is charged the gift cards'' face value on top of referral_fee_cents. For dealers whose cards 50. buys.';
comment on column tenants.referral_fee_bps is
  'HISTORICAL ONLY since 20261025000000_dealer_pricing. billing_events.fee_rate_bps records the rate past charges used; nothing new reads this. New charges use referral_fee_cents.';
