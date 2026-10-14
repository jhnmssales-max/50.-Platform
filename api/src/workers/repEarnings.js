// Turns the dealer payments that have actually cleared into sales-rep
// earnings (the rep_earnings ledger; see the rep_program migration).
//
// The rules, from rep_settings (defaults in brackets):
//   - When a dealer's $500 activation clears, its closer earns
//     activation_cents [$50] and its onboarder earns
//     onboarder_activation_cents [0 — the closer earns everything by
//     default; set it from the Money tab to pay an onboarder again]. A rate
//     of 0 earns no row at all, not a row worth nothing. One person who is
//     both earns both rates. Only the dealer's FIRST cleared live activation
//     counts (a duplicate payment is a refund, not a second bonus).
//   - When a referral fee (the 30%) clears, the closer earns referral_cents
//     [$1] and the onboarder onboarder_referral_cents [0, as above] for that
//     referral — each scaled down in proportion
//     when the per-card reward is under full_rate_card_cents [$50] (a $25 card
//     pays 50 cents, a $10 card 20 cents) and never scaled up. Referrals from
//     a rep's companies beyond their threshold_companies-th [2,000] pay that
//     role's after-threshold rate instead [50 cents for the closer], with the
//     same scaling. A rep's companies are the dealers they were ever assigned to
//     (closer or onboarder) that activated for real, counted in the order those
//     dealers activated.
//   - If a charge that earned something is later refunded or disputed (its
//     billing_events row goes to 'needs_refund' or 'disputed', or a dispute is
//     recorded against the same payment), a negative reversal row is added.
//
// Only money that is real and cleared counts: billing_events status
// 'succeeded' with livemode = true. A test-mode charge, a declined or pending
// charge, and any billing-exempt dealer (Good Steward Structures, North
// Mountain Structures, 50. itself) earn nobody anything. A charge only earns
// for reps who were on the dealer when it cleared (rep_assignments), so a
// dealer assigned later is not back-paid, and reassigning a dealer never moves
// money already earned.
//
// Exactly once, by the database: rep_earnings has a unique index per
// (charge, rep, role) and per reversed row, so this can run as often as it
// likes — it runs hourly from workers/renewalScheduler.js — and a re-run, an
// overlapping run, or two servers can never pay anything twice. All three
// steps run in one transaction under a Postgres advisory lock.
const { pool, assertServiceRoleConnection } = require('../db');

// Fixed and dedicated to this worker (rewards ...04, renewals ...05, billing emails ...06).
const ADVISORY_LOCK_KEY = 5031982007;

function log(event, data) {
  console.log(`REP_EARNINGS ${event} ${JSON.stringify(data)}`);
}

// The two kinds of earning share the "who held this dealer when it cleared"
// join. `roles` pairs each side of the assignment with its role name.
const ACTIVATION_SQL = `
  insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, source_billing_event_id, earned_at, detail)
  select r.rep_id, be.tenant_id, r.role, 'activation', r.rate, be.id, be.created_at,
         jsonb_build_object('rate_cents', r.rate, 'assignment_id', a.id)
  from billing_events be
  join tenants t on t.id = be.tenant_id and t.billing_required is true
  join rep_assignments a
    on a.tenant_id = be.tenant_id
   and be.created_at >= a.effective_from
   and (a.effective_to is null or be.created_at < a.effective_to)
  cross join rep_settings s
  -- Each side of the assignment with its own rate. The onboarder's is 0 by
  -- default, which the "r.rate > 0" below turns into no row at all rather
  -- than a row worth nothing.
  cross join lateral (values
    ('closer', a.closer_rep_id, s.activation_cents),
    ('onboarder', a.onboarder_rep_id, s.onboarder_activation_cents)
  ) r(role, rep_id, rate)
  where be.event_type = 'activation_charge'
    and be.status = 'succeeded'
    and be.livemode is true
    and r.rep_id is not null
    and r.rate > 0
    and be.id = (
      select f.id from billing_events f
      where f.tenant_id = be.tenant_id and f.event_type = 'activation_charge'
        and f.status = 'succeeded' and f.livemode is true
      order by f.created_at, f.id
      limit 1)
  on conflict (source_billing_event_id, rep_id, role) where kind <> 'reversal' do nothing`;

const REFERRAL_SQL = `
  insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, source_billing_event_id, earned_at, detail)
  select x.rep_id, x.tenant_id, x.role, 'referral', x.amount, x.billing_event_id, x.created_at,
         jsonb_build_object(
           'rate_cents', x.rate, 'reward_per_card_cents', x.reward, 'full_rate_card_cents', x.full_card,
           'company_number', x.company_number, 'after_threshold', x.after_threshold, 'assignment_id', x.assignment_id)
  from (
    select r.rep_id, be.tenant_id, r.role, be.id as billing_event_id, be.created_at, a.id as assignment_id,
           be.reward_amount_cents as reward, s.full_rate_card_cents as full_card,
           n.company_number,
           (n.company_number > s.threshold_companies) as after_threshold,
           case when n.company_number > s.threshold_companies then r.rate_after else r.rate_base end as rate,
           round(
             (case when n.company_number > s.threshold_companies then r.rate_after else r.rate_base end)::numeric
             * least(be.reward_amount_cents, s.full_rate_card_cents)::numeric / s.full_rate_card_cents
           )::int as amount
    from billing_events be
    join tenants t on t.id = be.tenant_id and t.billing_required is true
    join rep_assignments a
      on a.tenant_id = be.tenant_id
     and be.created_at >= a.effective_from
     and (a.effective_to is null or be.created_at < a.effective_to)
    cross join rep_settings s
    -- Each side of the assignment with its own pair of rates (normal, and
    -- past the threshold). The onboarder's are 0 by default, so by default
    -- only the closer earns; "x.amount > 0" below drops the rest.
    cross join lateral (values
      ('closer', a.closer_rep_id, s.referral_cents, s.referral_cents_after_threshold),
      ('onboarder', a.onboarder_rep_id, s.onboarder_referral_cents, s.onboarder_referral_cents_after_threshold)
    ) r(role, rep_id, rate_base, rate_after)
    cross join lateral (
      -- This rep's company number for this dealer: how many of their
      -- companies (ever assigned as closer or onboarder, activated for real)
      -- activated up to and including this one.
      select count(*)::int as company_number
      from (
        select distinct a2.tenant_id
        from rep_assignments a2
        where a2.closer_rep_id = r.rep_id or a2.onboarder_rep_id = r.rep_id
      ) mine
      join tenants t2 on t2.id = mine.tenant_id and t2.activation_livemode is true and t2.activation_paid_at is not null
      where (t2.activation_paid_at, t2.id) <= (t.activation_paid_at, t.id)
    ) n
    where be.event_type = 'referral_fee'
      and be.status = 'succeeded'
      and be.livemode is true
      and r.rep_id is not null
      and be.reward_amount_cents > 0
  ) x
  where x.amount > 0
  on conflict (source_billing_event_id, rep_id, role) where kind <> 'reversal' do nothing`;

const REVERSAL_SQL = `
  insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, reverses_earning_id, earned_at, detail)
  select e.rep_id, e.tenant_id, e.role, 'reversal', -e.amount_cents, e.id, now(),
         jsonb_build_object('reason', case when be.status in ('needs_refund', 'disputed') then be.status else 'dispute_recorded' end,
                            'source_billing_event_id', be.id)
  from rep_earnings e
  join billing_events be on be.id = e.source_billing_event_id
  where e.kind <> 'reversal'
    and (
      be.status in ('needs_refund', 'disputed')
      or exists (
        select 1 from billing_events d
        where d.tenant_id = e.tenant_id and d.event_type = 'dispute_created'
          and d.stripe_payment_intent_id is not null
          and d.stripe_payment_intent_id = be.stripe_payment_intent_id)
    )
  on conflict (reverses_earning_id) where kind = 'reversal' do nothing`;

// One pass. Resolves { activation, referral, reversals } — how many rows were
// added. With dryRun the same statements run and are rolled back, so the
// counts are exactly what a real run would add and nothing is kept.
async function runRepEarningsCycle({ dryRun = false } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    // A broad read run as the wrong database role returns nothing and looks
    // like "no earnings due" forever — refuse that loudly (see db.js).
    await assertServiceRoleConnection(client);
    const { rows: [lock] } = await client.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
    if (!lock.locked) {
      log('lock_not_acquired', { note: 'another rep-earnings cycle is already running; exiting' });
      return { skippedForLock: true, errored: 0 };
    }
    locked = true;

    await client.query('begin');
    try {
      const activation = (await client.query(ACTIVATION_SQL)).rowCount;
      const referral = (await client.query(REFERRAL_SQL)).rowCount;
      const reversals = (await client.query(REVERSAL_SQL)).rowCount;
      await client.query(dryRun ? 'rollback' : 'commit');
      const summary = { dryRun, activation, referral, reversals, errored: 0 };
      log('cycle_complete', summary);
      return summary;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runRepEarningsCycle, ADVISORY_LOCK_KEY };
